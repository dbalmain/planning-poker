import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { SESSION_TTL_MS } from "../../shared/ttl.ts";
import { deleteStaleBoards } from "../../worker/cleanup.ts";
import type {
  BoardMeta,
  ClientMsg,
  HistoryResponse,
  ServerMsg,
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
    await room.purge();

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
    const dave = pid(1);
    const socket = await openSocket(created.id);
    const welcome = await send(socket, {
      type: "join",
      player_id: dave,
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

describe("cleanup", () => {
  it("deletes unused sessions and their history after two weeks", async () => {
    const created = await createBoard("Old");
    const dave = pid(1);
    const socket = await openSocket(created.id);
    await send(socket, {
      type: "join",
      player_id: dave,
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
