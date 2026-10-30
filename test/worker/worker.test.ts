import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { seatId } from "../../shared/id.ts";
import {
  JOIN_REFUSED,
  PING,
  PONG,
  PRESENCE_TTL_MS,
  SESSION_TTL_MS,
} from "../../shared/ttl.ts";
import type { Room } from "../../worker/room.ts";
import { deleteStaleBoards } from "../../worker/cleanup.ts";
import { historyRowId, insertRound } from "../../worker/db.ts";
import type {
  BoardMeta,
  ClientMsg,
  CompletedRound,
  HistoryResponse,
  ServerMsg,
  Snapshot,
} from "../../shared/protocol.ts";

async function createBoard(name = "Sprint"): Promise<BoardMeta> {
  const res = await exports.default.fetch("https://example.com/api/boards", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, deck: "fibonacci" }),
  });
  expect(res.status).toBe(201);
  return await res.json<BoardMeta>();
}

function pid(n: number): string {
  return n.toString(16).padStart(32, "0");
}

function secret(n: number): string {
  return n.toString(16).padStart(32, "a");
}

async function openSocket(boardId: string): Promise<WebSocket> {
  const res = await exports.default.fetch(`https://example.com/ws/boards/${boardId}`, {
    headers: { Upgrade: "websocket" },
  });
  expect(res.status).toBe(101);
  const socket = res.webSocket;
  expect(socket).toBeDefined();
  if (!socket) {
    throw new Error("missing websocket");
  }
  socket.accept();
  return socket;
}

function nextMessage(socket: WebSocket): Promise<ServerMsg> {
  return new Promise((resolve, reject) => {
    const onMessage = (event: MessageEvent) => {
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("error", onError);
      if (typeof event.data !== "string") {
        reject(new Error("binary websocket message"));
        return;
      }
      resolve(JSON.parse(event.data) as ServerMsg);
    };
    const onError = () => {
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("error", onError);
      reject(new Error("websocket error"));
    };
    socket.addEventListener("message", onMessage);
    socket.addEventListener("error", onError);
  });
}

async function send(socket: WebSocket, msg: ClientMsg): Promise<ServerMsg> {
  const pending = nextMessage(socket);
  socket.send(JSON.stringify(msg));
  return pending;
}

async function idOf(n: number): Promise<string> {
  return seatId(secret(n));
}

async function join(socket: WebSocket, n: number): Promise<Snapshot> {
  const msg = await send(socket, {
    type: "join",
    secret: secret(n),
    name: `P${n}`,
    spectator: false,
  });
  if (msg.type !== "welcome") {
    throw new Error(`expected welcome, got ${msg.type}`);
  }
  return msg.state;
}

/** Set the ticket and return every state up to the one that reflects it. */
async function statesUntilTicket(socket: WebSocket, ticket: string): Promise<Snapshot[]> {
  const seen: Snapshot[] = [];
  socket.send(JSON.stringify({ type: "set_ticket", ticket } satisfies ClientMsg));
  for (;;) {
    const msg = await nextMessage(socket);
    if (msg.type === "state") {
      seen.push(msg.state);
      if (msg.state.ticket === ticket) {
        return seen;
      }
    }
  }
}

function closed(socket: WebSocket): Promise<number> {
  return new Promise((resolve) => {
    socket.addEventListener("close", (event) => resolve(event.code));
  });
}

type ServerAttachment = { openedAt: number; playerId: string | null };

/** Rewrite the server side of the matching sockets, as if time had passed. */
async function editSockets(
  boardId: string,
  playerId: string | null,
  edit: (attached: ServerAttachment) => ServerAttachment,
): Promise<WebSocket[]> {
  return runInDurableObject(env.ROOM.getByName(boardId), (_room: Room, state) => {
    const matched: WebSocket[] = [];
    for (const ws of state.getWebSockets()) {
      const attached = ws.deserializeAttachment() as ServerAttachment;
      if (attached.playerId === playerId) {
        ws.serializeAttachment(edit(attached));
        matched.push(ws);
      }
    }
    return matched;
  });
}

function age(ms: number): (attached: ServerAttachment) => ServerAttachment {
  return (attached) => ({ ...attached, openedAt: attached.openedAt - ms });
}

/** Fire the room's alarm now, failing if none was scheduled or none follows. */
async function runSweep(boardId: string): Promise<void> {
  const room = env.ROOM.getByName(boardId);
  expect(await runDurableObjectAlarm(room)).toBe(true);
  const next = await runInDurableObject(room, (_instance: Room, state) =>
    state.storage.getAlarm(),
  );
  expect(next).not.toBeNull();
}

async function playRound(
  socket: WebSocket,
  round: { ticket: string; card: string },
): Promise<ServerMsg> {
  await send(socket, { type: "set_ticket", ticket: round.ticket });
  await send(socket, { type: "vote", card: round.card });
  await send(socket, { type: "reveal" });
  await send(socket, { type: "pick_estimate" });
  await send(socket, { type: "set_estimate", card: round.card });
  return send(socket, { type: "confirm_round" });
}

describe("http", () => {
  it("lists decks", async () => {
    const res = await exports.default.fetch("https://example.com/api/decks");
    expect(res.status).toBe(200);
    const body = await res.json<{ id: string }[]>();
    expect(body.some((deck) => deck.id === "fibonacci")).toBe(true);
  });

  it("creates and fetches a board", async () => {
    const created = await createBoard("Sprint");
    expect(created.name).toBe("Sprint");
    expect(created.id).toHaveLength(32);
    const got = await exports.default.fetch(
      `https://example.com/api/boards/${created.id}`,
    );
    expect(got.status).toBe(200);
    const meta = await got.json<BoardMeta>();
    expect(meta.name).toBe("Sprint");
    expect(meta.deck).toBe("fibonacci");
  });

  it("history is empty until a round is saved", async () => {
    const created = await createBoard();
    const hist = await exports.default.fetch(
      `https://example.com/api/boards/${created.id}/history`,
    );
    expect(hist.status).toBe(200);
    const parsed = await hist.json<HistoryResponse>();
    expect(parsed.rounds).toEqual([]);
    expect(parsed.name).toBe("Sprint");
  });

  it("unknown board is 404", async () => {
    const id = "a".repeat(32);
    const res = await exports.default.fetch(`https://example.com/api/boards/${id}`);
    expect(res.status).toBe(404);
  });

  it("rejects malformed JSON as a bad request", async () => {
    const res = await exports.default.fetch("https://example.com/api/boards", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid JSON body" });
  });
});

describe("table", () => {
  it("loads board metadata when the DO is addressed directly", async () => {
    const created = await createBoard();
    const room = env.ROOM.getByName(created.id);
    await runInDurableObject(room, async (_instance: Room, state) => {
      await state.storage.deleteAll();
    });
    await evictDurableObject(room);

    const res = await room.fetch(
      new Request(`https://example.com/ws/boards/${created.id}`, {
        headers: { Upgrade: "websocket" },
      }),
    );
    expect(res.status).toBe(101);
    const socket = res.webSocket;
    expect(socket).toBeDefined();
    if (!socket) {
      throw new Error("missing websocket");
    }
    socket.accept();
    socket.close();
  });

  it("saves a round to history and drops the live ticket", async () => {
    const created = await createBoard();
    const socket = await openSocket(created.id);
    const welcome = await send(socket, {
      type: "join",
      secret: secret(1),
      name: "Dave",
      spectator: false,
    });
    expect(welcome.type).toBe("welcome");
    const saved = await playRound(socket, { ticket: "PROJ-2", card: "5" });
    expect(saved.type).toBe("state");
    if (saved.type !== "state") {
      return;
    }
    expect(saved.state.ticket).toBe("");
    expect(saved.state.phase).toBe("voting");
    expect(saved.state.completed).toEqual([]);

    const hist = await exports.default.fetch(
      `https://example.com/api/boards/${created.id}/history`,
    );
    const parsed = await hist.json<HistoryResponse>();
    expect(parsed.rounds).toHaveLength(1);
    expect(parsed.rounds[0]?.ticket).toBe("PROJ-2");
    expect(parsed.rounds[0]?.agreed).toBe("5");
    expect(parsed.rounds[0]?.votes[0]?.name).toBe("Dave");
  });
});

describe("seats", () => {
  it("an id read from a snapshot cannot take over that seat", async () => {
    const created = await createBoard();
    const aliceId = await idOf(1);
    const alice = await openSocket(created.id);
    await join(alice, 1);
    await send(alice, { type: "vote", card: "5" });

    const mallory = await openSocket(created.id);
    const seen = await join(mallory, 2);
    expect(seen.players.map((p) => p.id)).toContain(aliceId);
    const hijack = await openSocket(created.id);
    const taken = await send(hijack, {
      type: "join",
      secret: aliceId,
      name: "P1",
      spectator: false,
    });
    if (taken.type !== "welcome") {
      throw new Error(`expected welcome, got ${taken.type}`);
    }
    expect(taken.state.you.id).not.toBe(aliceId);
    await send(hijack, { type: "vote", card: "13" });

    const back = await openSocket(created.id);
    const rejoined = await join(back, 1);
    expect(rejoined.you.id).toBe(aliceId);
    expect(rejoined.you.vote).toBe("5");
  });

  it("a join without a secret is told to reload and left open", async () => {
    const created = await createBoard();
    const socket = await openSocket(created.id);
    const oldJoin = {
      type: "join",
      player_id: pid(1),
      name: "Old tab",
      spectator: false,
    } as unknown as ClientMsg;
    const stale = { type: "error", message: "this page is out of date — reload it" };
    expect(await send(socket, oldJoin)).toEqual(stale);
    expect(await send(socket, oldJoin)).toEqual(stale);
  });

  it("a join that can never succeed is refused and closed", async () => {
    const created = await createBoard();
    const socket = await openSocket(created.id);
    const shut = closed(socket);
    const reply = await send(socket, {
      type: "join",
      secret: secret(1),
      name: "   ",
      spectator: false,
    });
    expect(reply).toEqual({ type: "error", message: "name cannot be empty" });
    expect(await shut).toBe(JOIN_REFUSED);
  });
});

describe("presence", () => {
  it("closing one of a player's tabs keeps them online", async () => {
    const created = await createBoard();
    const dave = await idOf(1);
    await join(await openSocket(created.id), 1);
    await join(await openSocket(created.id), 1);
    const observer = await openSocket(created.id);
    await join(observer, 2);
    const [first, second] = await editSockets(created.id, dave, (a) => a);
    if (!first || !second) {
      throw new Error("expected two sockets for the player");
    }

    const room = env.ROOM.getByName(created.id);
    await runInDurableObject(room, (instance: Room) => {
      first.close();
      instance.webSocketClose(first);
    });
    for (const state of await statesUntilTicket(observer, "A")) {
      expect(state.players.find((p) => p.id === dave)?.connected).toBe(true);
    }

    await runInDurableObject(room, (instance: Room) => {
      second.close();
      instance.webSocketClose(second);
    });
    const after = await statesUntilTicket(observer, "B");
    expect(after.at(-1)?.players.find((p) => p.id === dave)?.connected).toBe(false);
  });

  it("the alarm closes silent sockets and removes their players", async () => {
    const created = await createBoard();
    const silent = await openSocket(created.id);
    await join(silent, 1);
    const fresh = await openSocket(created.id);
    await join(fresh, 2);
    await editSockets(created.id, await idOf(1), age(PRESENCE_TTL_MS + 60_000));

    const silentClosed = closed(silent);
    await runSweep(created.id);
    expect(await silentClosed).toBe(4000);
    const late = await openSocket(created.id);
    const ids = (await join(late, 3)).players.map((p) => p.id).sort();
    expect(ids).toEqual([await idOf(2), await idOf(3)].sort());
  });

  it("a heartbeat keeps an old socket alive", async () => {
    const created = await createBoard();
    const socket = await openSocket(created.id);
    await join(socket, 1);
    const alive = await idOf(1);
    await editSockets(created.id, alive, age(PRESENCE_TTL_MS + 60_000));
    const pong = new Promise<unknown>((resolve) => {
      socket.addEventListener("message", (event) => resolve(event.data), { once: true });
    });
    socket.send(PING);
    expect(await pong).toBe(PONG);

    await runSweep(created.id);
    const observer = await openSocket(created.id);
    const players = (await join(observer, 2)).players;
    expect(players.find((p) => p.id === alive)?.connected).toBe(true);
  });

  it("the alarm closes sockets that never join", async () => {
    const created = await createBoard();
    const idle = await openSocket(created.id);
    await editSockets(created.id, null, age(2 * 60_000));
    const shut = closed(idle);
    await runSweep(created.id);
    expect(await shut).toBe(4000);
  });

  it("a player marked online with no socket goes offline at the next sweep", async () => {
    const created = await createBoard();
    const ghost = await idOf(1);
    await join(await openSocket(created.id), 1);
    const observer = await openSocket(created.id);
    await join(observer, 2);
    // As after an eviction: the roster says online, but no socket carries the id.
    await editSockets(created.id, ghost, (a) => ({ ...a, playerId: pid(99) }));

    await runSweep(created.id);
    const after = await statesUntilTicket(observer, "A");
    const player = after.at(-1)?.players.find((p) => p.id === ghost);
    expect(player?.connected).toBe(false);
  });
});

describe("restore", () => {
  it("players whose sockets did not survive eviction go offline", async () => {
    const created = await createBoard();
    const room = env.ROOM.getByName(created.id);
    await join(await openSocket(created.id), 1);
    // As for a board saved before rooms kept an alarm.
    await runInDurableObject(room, async (_instance: Room, state) => {
      await state.storage.deleteAlarm();
    });
    await evictDurableObject(room, { webSockets: "close" });

    await runInDurableObject(room, () => undefined);
    await runSweep(created.id);
    const observer = await openSocket(created.id);
    const players = (await join(observer, 2)).players;
    const ghost = await idOf(1);
    expect(players.find((p) => p.id === ghost)?.connected).toBe(false);
  });
});

describe("purge", () => {
  it("a purged room stays gone, even after eviction", async () => {
    const created = await createBoard();
    const room = env.ROOM.getByName(created.id);
    await deleteStaleBoards(env.DB, Date.now() + SESSION_TTL_MS + 1_000);
    await room.purge();
    const upgrade = new Request(`https://example.com/ws/boards/${created.id}`, {
      headers: { Upgrade: "websocket" },
    });
    const sameActivation = await room.fetch(upgrade.clone());
    expect(sameActivation.status).toBe(404);
    await sameActivation.body?.cancel();
    // A fresh activation has forgotten the purge; D1 must still say no.
    await evictDurableObject(room);
    expect((await room.fetch(upgrade)).status).toBe(404);
  });
});

describe("races", () => {
  it("an upgrade whose D1 read straddles a purge does not rebuild the room", async () => {
    const created = await createBoard();
    const room = env.ROOM.getByName(created.id);
    await runInDurableObject(room, async (_instance: Room, state) => {
      await state.storage.deleteAll();
    });
    await evictDurableObject(room);

    const status = await runInDurableObject(room, async (instance: Room, state) => {
      const upgrading = instance.fetch(
        new Request(`https://example.com/ws/boards/${created.id}`, {
          headers: { Upgrade: "websocket" },
        }),
      );
      await instance.purge();
      const res = await upgrading;
      await res.body?.cancel();
      expect(await state.storage.get("board")).toBeUndefined();
      return res.status;
    });
    expect(status).toBe(404);
  });

  it("a second confirm during the first one's save is refused", async () => {
    const created = await createBoard();
    const socket = await openSocket(created.id);
    await join(socket, 1);
    await send(socket, { type: "set_ticket", ticket: "T-1" });
    await send(socket, { type: "vote", card: "5" });
    await send(socket, { type: "reveal" });
    await send(socket, { type: "pick_estimate" });
    await send(socket, { type: "set_estimate", card: "5" });

    const errors: string[] = [];
    socket.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data as string) as ServerMsg;
      if (msg.type === "error") {
        errors.push(msg.message);
      }
    });
    const [server] = await editSockets(created.id, await idOf(1), (a) => a);
    if (!server) {
      throw new Error("missing server socket");
    }
    const confirm = JSON.stringify({ type: "confirm_round" } satisfies ClientMsg);
    await runInDurableObject(env.ROOM.getByName(created.id), async (instance: Room) => {
      await Promise.all([
        instance.webSocketMessage(server, confirm),
        instance.webSocketMessage(server, confirm),
      ]);
    });
    await statesUntilTicket(socket, "T-2");
    expect(errors).toEqual(["already saving this round"]);
  });

  it("saving the same round twice stores one history row", async () => {
    const created = await createBoard();
    const round = {
      id: pid(7),
      ticket: "T-1",
      agreed: "5",
      votes: [{ name: "P1", card: "5" }],
      completed_at: new Date().toISOString(),
    };
    await insertRound(env.DB, created.id, round);
    await insertRound(env.DB, created.id, round);
    const hist = await exports.default.fetch(
      `https://example.com/api/boards/${created.id}/history`,
    );
    expect((await hist.json<HistoryResponse>()).rounds).toHaveLength(1);
  });
});

describe("restored rounds", () => {
  const boardKey = "board";

  /** Reach "choosing" with `card` agreed; return the persisted board at that point. */
  async function choosing(
    boardId: string,
    socket: WebSocket,
    card: string,
  ): Promise<unknown> {
    await join(socket, 1);
    await send(socket, { type: "set_ticket", ticket: "T-1" });
    await send(socket, { type: "vote", card });
    await send(socket, { type: "reveal" });
    await send(socket, { type: "pick_estimate" });
    await send(socket, { type: "set_estimate", card });
    return runInDurableObject(env.ROOM.getByName(boardId), (_r: Room, state) =>
      state.storage.get(boardKey),
    );
  }

  async function agreed(boardId: string): Promise<string[]> {
    const hist = await exports.default.fetch(
      `https://example.com/api/boards/${boardId}/history`,
    );
    return (await hist.json<HistoryResponse>()).rounds.map((r) => r.agreed).sort();
  }

  /** A row for the live round as it would have been committed with `card`. */
  async function committed(saved: unknown, card: string): Promise<CompletedRound> {
    const round = {
      id: (saved as { roundId: string }).roundId,
      ticket: "T-1",
      agreed: card,
      votes: [{ name: "P1", card }],
      completed_at: new Date().toISOString(),
    };
    return { ...round, id: await historyRowId(round) };
  }

  /** As if the room reset after D1 committed but before the next ticket was stored. */
  async function restore(boardId: string, saved: unknown): Promise<WebSocket> {
    const room = env.ROOM.getByName(boardId);
    await runInDurableObject(room, async (_r: Room, state) => {
      await state.storage.put(boardKey, saved);
    });
    await evictDurableObject(room, { webSockets: "close" });
    const socket = await openSocket(boardId);
    await join(socket, 1);
    return socket;
  }

  it("confirming a round already saved stores it once", async () => {
    const created = await createBoard();
    const saved = await choosing(created.id, await openSocket(created.id), "8");
    await insertRound(env.DB, created.id, await committed(saved, "8"));
    await send(await restore(created.id, saved), { type: "confirm_round" });
    expect(await agreed(created.id)).toEqual(["8"]);
  });

  it("a saved round changed after a restore is stored as a new result, once", async () => {
    const created = await createBoard();
    const saved = await choosing(created.id, await openSocket(created.id), "8");
    await insertRound(env.DB, created.id, await committed(saved, "5"));
    await send(await restore(created.id, saved), { type: "confirm_round" });
    expect(await agreed(created.id)).toEqual(["5", "8"]);
    // The confirm of 8 committed, then the room reset again before advancing.
    await send(await restore(created.id, saved), { type: "confirm_round" });
    expect(await agreed(created.id)).toEqual(["5", "8"]);
  });
});

describe("cleanup", () => {
  it("deletes unused sessions and their history after two weeks", async () => {
    const created = await createBoard("Old");
    const socket = await openSocket(created.id);
    await send(socket, {
      type: "join",
      secret: secret(1),
      name: "Dave",
      spectator: false,
    });
    await playRound(socket, { ticket: "OLD-1", card: "3" });
    socket.close();

    const old = new Date(Date.now() - SESSION_TTL_MS - 60_000).toISOString();
    await env.DB.prepare("UPDATE boards SET last_used_at = ? WHERE id = ?")
      .bind(old, created.id)
      .run();

    const ids = await deleteStaleBoards(env.DB);
    expect(ids).toContain(created.id);
    await env.ROOM.getByName(created.id).purge();

    const gone = await exports.default.fetch(
      `https://example.com/api/boards/${created.id}`,
    );
    expect(gone.status).toBe(404);
    const hist = await exports.default.fetch(
      `https://example.com/api/boards/${created.id}/history`,
    );
    expect(hist.status).toBe(404);
    const roundCount = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM rounds WHERE board_id = ?",
    )
      .bind(created.id)
      .first<{ count: number }>();
    expect(roundCount?.count).toBe(0);
  });

  it("keeps a session used inside the last two weeks", async () => {
    const created = await createBoard("Fresh");
    const ids = await deleteStaleBoards(env.DB);
    expect(ids).not.toContain(created.id);
    const got = await exports.default.fetch(
      `https://example.com/api/boards/${created.id}`,
    );
    expect(got.status).toBe(200);
  });

  it("deletes stale sessions one page at a time", async () => {
    const boards = await Promise.all([
      createBoard("Old 1"),
      createBoard("Old 2"),
      createBoard("Old 3"),
    ]);
    const old = new Date(Date.now() - SESSION_TTL_MS - 60_000).toISOString();
    await env.DB.batch(
      boards.map((board) =>
        env.DB.prepare("UPDATE boards SET last_used_at = ? WHERE id = ?").bind(
          old,
          board.id,
        ),
      ),
    );

    const firstPage = await deleteStaleBoards(env.DB, Date.now(), 2);
    expect(firstPage).toHaveLength(2);
    const afterFirst = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM boards WHERE id IN (?, ?, ?)",
    )
      .bind(...boards.map((board) => board.id))
      .first<{ count: number }>();
    expect(afterFirst?.count).toBe(1);

    const secondPage = await deleteStaleBoards(env.DB, Date.now(), 2);
    expect(secondPage).toHaveLength(1);
    expect(new Set([...firstPage, ...secondPage])).toEqual(
      new Set(boards.map((board) => board.id)),
    );
  });
});
