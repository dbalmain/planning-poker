import { listDecks } from "../shared/deck.ts";
import { Errors, errorBody } from "../shared/errors.ts";
import type { CreateBoardRequest } from "../shared/protocol.ts";
import { matchRoute } from "../shared/routes.ts";
import { CLEANUP_BATCH_SIZE, CLEANUP_MAX_BATCHES, deleteStaleBoards } from "./cleanup.ts";
import { createBoard, getBoard, listHistory, requireBoard, touchBoard } from "./db.ts";
import { logInternalError } from "./log.ts";
import { Room, withBoardMetadata } from "./room.ts";

export { Room };

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function fail(error: unknown): Response {
  logInternalError("request failed", error);
  const body = errorBody(error);
  return json({ error: body.error }, body.status);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await handle(request, env);
    } catch (error) {
      return fail(error);
    }
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    let purged = 0;
    let purgeFailures = 0;
    for (let batch = 0; batch < CLEANUP_MAX_BATCHES; batch += 1) {
      const ids = await deleteStaleBoards(env.DB);
      if (ids.length === 0) {
        break;
      }
      purgeFailures += await purgeRooms(env, ids);
      purged += ids.length;
      if (ids.length < CLEANUP_BATCH_SIZE) {
        break;
      }
    }
    console.info(
      JSON.stringify({
        level: "info",
        message: "purged stale sessions",
        count: purged,
        failures: purgeFailures,
        capped: purged === CLEANUP_BATCH_SIZE * CLEANUP_MAX_BATCHES,
      }),
    );
  },
} satisfies ExportedHandler<Env>;

async function handle(request: Request, env: Env): Promise<Response> {
  const route = matchRoute(new URL(request.url).pathname);

  if (request.method === "GET" && route.kind === "health") {
    return new Response("ok");
  }

  if (request.method === "GET" && route.kind === "api_decks") {
    return json(listDecks());
  }

  if (request.method === "POST" && route.kind === "api_boards") {
    const body = await readCreateBoardRequest(request);
    if (!body) {
      return json({ error: "unknown deck" }, 400);
    }
    const name = typeof body.name === "string" ? body.name : "";
    const meta = await createBoard(env.DB, name, body.deck);
    await env.ROOM.getByName(meta.id).init(meta);
    return json(meta, 201);
  }

  if (request.method === "GET" && route.kind === "api_board") {
    const id = route.boardId;
    const board = await getBoard(env.DB, id);
    if (!board) {
      return json({ error: "board not found" }, 404);
    }
    return json({ id: board.id, name: board.name, deck: board.deck });
  }

  if (request.method === "GET" && route.kind === "api_board_history") {
    const id = route.boardId;
    const history = await listHistory(env.DB, id);
    await touchBoard(env.DB, id);
    return json(history);
  }

  if (route.kind === "ws_board") {
    const board = await requireBoard(env.DB, route.boardId);
    return env.ROOM.getByName(route.boardId).fetch(withBoardMetadata(request, board));
  }

  return json({ error: "not found" }, 404);
}

async function readCreateBoardRequest(
  request: Request,
): Promise<CreateBoardRequest | null> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw Errors.invalidJson();
  }
  if (typeof body !== "object" || body === null) {
    return null;
  }
  const deck = "deck" in body ? body.deck : undefined;
  const name = "name" in body ? body.name : undefined;
  if (typeof deck !== "string") {
    return null;
  }
  return typeof name === "string" ? { name, deck } : { deck };
}

async function purgeRooms(env: Env, ids: string[]): Promise<number> {
  const concurrency = Math.min(10, ids.length);
  let next = 0;
  let failures = 0;
  const worker = async (): Promise<void> => {
    while (next < ids.length) {
      const id = ids[next];
      next += 1;
      if (!id) {
        continue;
      }
      try {
        await env.ROOM.getByName(id).purge();
      } catch (error) {
        failures += 1;
        logInternalError("stale room purge failed", error);
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return failures;
}
