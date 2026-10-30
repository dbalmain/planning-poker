import { DurableObject } from "cloudflare:workers";
import { parseDeck } from "../shared/deck.ts";
import { AppError, Errors, errorBody } from "../shared/errors.ts";
import { Board } from "../shared/game.ts";
import type { ClientMsg, ServerMsg } from "../shared/protocol.ts";
import { isHexId, seatId } from "../shared/id.ts";
import { matchRoute } from "../shared/routes.ts";
import { JOIN_REFUSED, PING, PONG, PRESENCE_TTL_MS } from "../shared/ttl.ts";
import {
  historyRowId,
  insertRound,
  requireBoard,
  setBoardDeck,
  touchBoard,
} from "./db.ts";
import { logInternalError } from "./log.ts";

/** `playerId` is null until the socket has joined. */
type Attachment = { openedAt: number; playerId: string | null };

const TOUCH_INTERVAL_MS = 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 1000;
const JOIN_DEADLINE_MS = 60 * 1000;
/** Retryable: the client reconnects. */
const IDLE = 4000;
export class Room extends DurableObject<Env> {
  #board: Board | null = null;
  #lastTouchedAt = 0;
  #writeChain: Promise<void> = Promise.resolve();
  #confirming = false;
  /** Set once the session is deleted; an upgrade already in flight must not revive it. */
  #purged = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
    void ctx.blockConcurrencyWhile(async () => {
      const saved = await ctx.storage.get<ReturnType<Board["toJSON"]>>("board");
      if (saved) {
        this.#board = Board.fromJSON(saved);
        if (this.#board.players.size > 0) {
          await this.ensureSweep();
        }
      }
    });
  }

  async init(meta: { id: string; name: string; deck: string }): Promise<void> {
    if (this.#purged) {
      throw Errors.boardNotFound();
    }
    if (this.#board) {
      return;
    }
    this.#board = Board.create(meta.id, meta.name, parseDeck(meta.deck));
    this.#lastTouchedAt = Date.now();
    await this.persist();
  }

  async purge(): Promise<void> {
    this.#purged = true;
    this.#board = null;
    await this.#writeChain;
    await this.ctx.storage.deleteAll();
    for (const ws of this.ctx.getWebSockets()) {
      ws.close(1001, "session expired");
    }
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }
    try {
      await this.ensureBoard(request);
    } catch (error) {
      logInternalError("WebSocket connection failed", error);
      const body = errorBody(error);
      return Response.json({ error: body.error }, { status: body.status });
    }

    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment({
      openedAt: Date.now(),
      playerId: null,
    } satisfies Attachment);
    await this.ensureSweep();
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  override async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    // A socket the sweep has closed keeps receiving until the peer answers.
    if (ws.readyState !== WebSocket.OPEN) {
      return;
    }
    if (typeof message !== "string") {
      this.send(ws, { type: "error", message: "invalid message" });
      return;
    }
    let msg: ClientMsg;
    try {
      msg = JSON.parse(message) as ClientMsg;
    } catch {
      this.send(ws, { type: "error", message: "invalid message" });
      return;
    }

    const attached = ws.deserializeAttachment() as Attachment | null;
    try {
      if (!attached?.playerId) {
        if (msg.type !== "join") {
          this.send(ws, { type: "error", message: "join the table first" });
          return;
        }
        if (typeof msg.secret !== "string") {
          // Left open: an old page reconnects at once if closed, so let it sit
          // on the message until the join deadline.
          this.send(ws, {
            type: "error",
            message: errorBody(Errors.staleClient()).error,
          });
          return;
        }
        if (!isHexId(msg.secret)) {
          throw Errors.invalidPlayerId();
        }
        const playerId = await seatId(msg.secret);
        if (ws.readyState !== WebSocket.OPEN) {
          return;
        }
        const board = this.requireLive();
        board.join(playerId, msg.name, msg.spectator);
        ws.serializeAttachment({
          openedAt: attached?.openedAt ?? Date.now(),
          playerId,
        } satisfies Attachment);
        this.send(ws, {
          type: "welcome",
          player_id: playerId,
          state: board.snapshot(playerId),
        });
        this.broadcastExcept(ws);
        this.scheduleWrite({ touch: true });
        return;
      }

      const board = this.requireLive();
      const playerId = attached.playerId;
      if (msg.type === "confirm_round") {
        if (this.#confirming) {
          throw Errors.alreadySaving();
        }
        const completed = board.buildCompletedRound(playerId);
        this.#confirming = true;
        try {
          const id = await historyRowId(completed);
          await insertRound(this.env.DB, board.id, { ...completed, id });
        } finally {
          this.#confirming = false;
        }
        board.startNextTicket();
      } else {
        board.apply(playerId, msg);
      }
      this.broadcast();
      this.scheduleWrite({ setDeck: msg.type === "set_deck", touch: true });
    } catch (error) {
      logInternalError("WebSocket message failed", error);
      const body = errorBody(error);
      this.send(ws, { type: "error", message: body.error });
      if (!attached?.playerId) {
        ws.close(JOIN_REFUSED, "join refused");
      }
    }
  }

  override webSocketClose(ws: WebSocket): void {
    const attached = ws.deserializeAttachment() as Attachment | null;
    if (!attached?.playerId || !this.#board) {
      return;
    }
    if (this.release(ws, attached.playerId, Date.now())) {
      this.broadcast();
      this.scheduleWrite();
    }
  }

  override async alarm(): Promise<void> {
    await this.sweep(Date.now());
  }

  /** Close silent sockets and remove players gone longer than the presence TTL. */
  private async sweep(now: number): Promise<void> {
    const board = this.#board;
    if (!board) {
      return;
    }
    const cutoff = now - PRESENCE_TTL_MS;
    let changed = false;
    const live = new Set<string>();
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.readyState !== WebSocket.OPEN) {
        continue;
      }
      const attached = ws.deserializeAttachment() as Attachment | null;
      const openedAt = attached?.openedAt ?? 0;
      if (!attached?.playerId) {
        if (openedAt < now - JOIN_DEADLINE_MS) {
          ws.close(IDLE, "join timed out");
        }
        continue;
      }
      const pinged = this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? 0;
      const seen = Math.max(openedAt, pinged);
      if (seen < cutoff) {
        ws.close(IDLE, "idle");
        changed = this.release(ws, attached.playerId, seen) || changed;
      } else {
        live.add(attached.playerId);
      }
    }
    // Restored state can claim sockets that did not survive eviction.
    for (const player of board.players.values()) {
      if (player.connected && !live.has(player.id)) {
        board.disconnect(player.id, now);
        changed = true;
      }
    }
    changed = board.dropAbsent(cutoff) || changed;
    if (changed) {
      this.broadcast();
      this.scheduleWrite();
    }
    if (board.hasExpirable() || this.ctx.getWebSockets().length > 0) {
      await this.ctx.storage.setAlarm(now + SWEEP_INTERVAL_MS);
    }
  }

  override webSocketError(ws: WebSocket): void {
    this.webSocketClose(ws);
  }

  private async ensureBoard(request: Request): Promise<Board> {
    const existing = this.current();
    if (existing) {
      return existing;
    }
    const route = matchRoute(new URL(request.url).pathname);
    if (route.kind !== "ws_board") {
      throw Errors.boardNotFound();
    }
    // Always D1, never caller-supplied metadata: a request that raced cleanup
    // must not rebuild a deleted session.
    const meta = await requireBoard(this.env.DB, route.boardId);
    // purge() or a concurrent upgrade may have run during the await.
    const raced = this.current();
    if (raced) {
      return raced;
    }
    this.#board = Board.create(meta.id, meta.name, parseDeck(meta.deck));
    this.#lastTouchedAt = Date.parse(meta.last_used_at);
    if (Number.isNaN(this.#lastTouchedAt)) {
      this.#lastTouchedAt = 0;
    }
    await this.persist();
    return this.#board;
  }

  /** The live board, or null before one is loaded; throws once purged. */
  private current(): Board | null {
    if (this.#purged) {
      throw Errors.boardNotFound();
    }
    return this.#board;
  }

  /** Mark the player offline unless another of their sockets is still open. */
  private release(closing: WebSocket, playerId: string, lastSeenAt: number): boolean {
    const board = this.requireLive();
    for (const client of this.ctx.getWebSockets()) {
      if (client === closing || client.readyState !== WebSocket.OPEN) {
        continue;
      }
      const attached = client.deserializeAttachment() as Attachment | null;
      if (attached?.playerId === playerId) {
        return false;
      }
    }
    board.disconnect(playerId, lastSeenAt);
    return true;
  }

  private async ensureSweep(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + SWEEP_INTERVAL_MS);
    }
  }

  private requireLive(): Board {
    if (!this.#board) {
      throw Errors.boardNotFound();
    }
    return this.#board;
  }

  private async persist(): Promise<void> {
    if (this.#board) {
      await this.ctx.storage.put("board", this.#board.toJSON());
    }
  }

  private scheduleWrite(options: { setDeck?: boolean; touch?: boolean } = {}): void {
    const board = this.requireLive();
    const snapshot = board.toJSON();
    const boardId = board.id;
    const deck = board.deck.id;
    this.#writeChain = this.#writeChain
      .then(async () => {
        // A purge may have landed while this write was queued.
        if (this.#board !== board) {
          return;
        }
        await this.ctx.storage.put("board", snapshot);
        if (options.setDeck) {
          await setBoardDeck(this.env.DB, boardId, deck);
        }
        if (options.touch) {
          await this.touchIfDue(boardId);
        }
      })
      .catch((error: unknown) => {
        logInternalError("room state persistence failed", error);
      });
    this.ctx.waitUntil(this.#writeChain);
  }

  private async touchIfDue(boardId: string): Promise<void> {
    const now = Date.now();
    if (now - this.#lastTouchedAt < TOUCH_INTERVAL_MS) {
      return;
    }
    this.#lastTouchedAt = now;
    try {
      await touchBoard(this.env.DB, boardId);
    } catch (error) {
      if (this.#lastTouchedAt === now) {
        this.#lastTouchedAt = 0;
      }
      throw error;
    }
  }

  private broadcast(): void {
    for (const client of this.ctx.getWebSockets()) {
      this.pushState(client);
    }
  }

  private broadcastExcept(skip: WebSocket): void {
    for (const client of this.ctx.getWebSockets()) {
      if (client !== skip) {
        this.pushState(client);
      }
    }
  }

  private pushState(ws: WebSocket): void {
    if (!this.#board || ws.readyState !== WebSocket.OPEN) {
      return;
    }
    const attached = ws.deserializeAttachment() as Attachment | null;
    if (!attached?.playerId) {
      return;
    }
    try {
      this.send(ws, { type: "state", state: this.#board.snapshot(attached.playerId) });
    } catch (error) {
      if (error instanceof AppError && error.message === "join the table first") {
        return;
      }
      logInternalError("WebSocket state push failed", error);
      const body = errorBody(error);
      this.send(ws, { type: "error", message: body.error });
    }
  }

  private send(ws: WebSocket, msg: ServerMsg): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }
}
