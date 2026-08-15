import { DurableObject } from "cloudflare:workers";
import { parseDeck } from "../shared/deck.ts";
import { AppError, Errors, errorBody } from "../shared/errors.ts";
import { Board } from "../shared/game.ts";
import type { ClientMsg, ServerMsg } from "../shared/protocol.ts";
import { matchRoute } from "../shared/routes.ts";
import { insertRound, requireBoard, setBoardDeck, touchBoard } from "./db.ts";
import type { BoardRow } from "./db.ts";
import { logInternalError } from "./log.ts";

type Attachment = { playerId: string };

const TOUCH_INTERVAL_MS = 60 * 60 * 1000;
const BOARD_META_HEADER = "X-Planning-Poker-Board";

export function withBoardMetadata(request: Request, board: BoardRow): Request {
  const headers = new Headers(request.headers);
  headers.set(BOARD_META_HEADER, encodeURIComponent(JSON.stringify(board)));
  return new Request(request, { headers });
}

export class Room extends DurableObject<Env> {
  #board: Board | null = null;
  #lastTouchedAt = 0;
  #writeChain: Promise<void> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const saved = await ctx.storage.get<ReturnType<Board["toJSON"]>>("board");
      if (saved) {
        this.#board = Board.fromJSON(saved);
      }
    });
  }

  async init(meta: { id: string; name: string; deck: string }): Promise<void> {
    if (this.#board) {
      return;
    }
    this.#board = Board.create(meta.id, meta.name, parseDeck(meta.deck));
    this.#lastTouchedAt = Date.now();
    await this.persist();
  }

  async purge(): Promise<void> {
    this.#board = null;
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
      await this.ensureBoard(request, readBoardMetadata(request));
    } catch (error) {
      logInternalError("WebSocket connection failed", error);
      const body = errorBody(error);
      return Response.json({ error: body.error }, { status: body.status });
    }

    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
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
      if (!attached) {
        if (msg.type !== "join") {
          this.send(ws, { type: "error", message: "join the table first" });
          return;
        }
        const board = this.requireLive();
        board.join(msg.player_id, msg.name, msg.spectator);
        ws.serializeAttachment({ playerId: msg.player_id } satisfies Attachment);
        this.send(ws, { type: "welcome", player_id: msg.player_id, state: board.snapshot(msg.player_id) });
        this.broadcastExcept(ws);
        this.scheduleWrite({ touch: true });
        return;
      }

      const board = this.requireLive();
      const playerId = attached.playerId;
      if (msg.type === "confirm_round") {
        const completed = board.buildCompletedRound(playerId);
        await insertRound(this.env.DB, board.id, completed);
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
    }
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    const attached = ws.deserializeAttachment() as Attachment | null;
    if (!attached || !this.#board) {
      return;
    }
    this.#board.disconnect(attached.playerId);
    this.broadcast();
    this.scheduleWrite();
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws);
  }

  private async ensureBoard(request: Request, supplied?: BoardRow): Promise<Board> {
    if (this.#board) {
      return this.#board;
    }
    let meta = supplied;
    if (!meta) {
      const route = matchRoute(new URL(request.url).pathname);
      if (route.kind !== "ws_board") {
        throw Errors.boardNotFound();
      }
      meta = await requireBoard(this.env.DB, route.boardId);
    }
    this.#board = Board.create(meta.id, meta.name, parseDeck(meta.deck));
    this.#lastTouchedAt = Date.parse(meta.last_used_at);
    if (Number.isNaN(this.#lastTouchedAt)) {
      this.#lastTouchedAt = 0;
    }
    await this.persist();
    return this.#board;
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
    if (!attached) {
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

function readBoardMetadata(request: Request): BoardRow | undefined {
  const encoded = request.headers.get(BOARD_META_HEADER);
  if (!encoded) {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(decodeURIComponent(encoded));
    if (
      typeof value === "object" &&
      value !== null &&
      "id" in value &&
      "name" in value &&
      "deck" in value &&
      "created_at" in value &&
      "last_used_at" in value &&
      typeof value.id === "string" &&
      typeof value.name === "string" &&
      typeof value.deck === "string" &&
      typeof value.created_at === "string" &&
      typeof value.last_used_at === "string"
    ) {
      return {
        id: value.id,
        name: value.name,
        deck: value.deck,
        created_at: value.created_at,
        last_used_at: value.last_used_at,
      };
    }
  } catch {
    return undefined;
  }
  return undefined;
}
