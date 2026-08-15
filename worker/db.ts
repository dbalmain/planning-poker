import { parseDeck } from "../shared/deck.ts";
import { Errors } from "../shared/errors.ts";
import { normalizeBoardName } from "../shared/game.ts";
import { randomId } from "../shared/id.ts";
import type {
  BoardMeta,
  CompletedRound,
  HistoryResponse,
  VoteRecord,
} from "../shared/protocol.ts";

export type BoardRow = {
  id: string;
  name: string;
  deck: string;
  created_at: string;
  last_used_at: string;
};

export async function createBoard(
  db: D1Database,
  name: string | undefined,
  deckId: string,
): Promise<BoardMeta> {
  parseDeck(deckId);
  const id = randomId();
  const normalized = normalizeBoardName(name ?? "");
  const now = new Date().toISOString();
  await db
    .prepare(
      "INSERT INTO boards (id, name, deck, created_at, last_used_at) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(id, normalized, deckId, now, now)
    .run();
  return { id, name: normalized, deck: deckId };
}

export async function getBoard(db: D1Database, id: string): Promise<BoardRow | null> {
  return db
    .prepare("SELECT id, name, deck, created_at, last_used_at FROM boards WHERE id = ?")
    .bind(id)
    .first<BoardRow>();
}

export async function requireBoard(db: D1Database, id: string): Promise<BoardRow> {
  const board = await getBoard(db, id);
  if (!board) {
    throw Errors.boardNotFound();
  }
  return board;
}

export async function touchBoard(db: D1Database, id: string): Promise<void> {
  await db
    .prepare("UPDATE boards SET last_used_at = ? WHERE id = ?")
    .bind(new Date().toISOString(), id)
    .run();
}

export async function setBoardDeck(
  db: D1Database,
  id: string,
  deck: string,
): Promise<void> {
  await db.prepare("UPDATE boards SET deck = ? WHERE id = ?").bind(deck, id).run();
}

export async function insertRound(
  db: D1Database,
  boardId: string,
  round: CompletedRound,
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO rounds (id, board_id, ticket, agreed, votes_json, completed_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(
      round.id,
      boardId,
      round.ticket,
      round.agreed,
      JSON.stringify(round.votes),
      round.completed_at,
    )
    .run();
}

export async function listHistory(
  db: D1Database,
  boardId: string,
): Promise<HistoryResponse> {
  const board = await requireBoard(db, boardId);
  const rows = await db
    .prepare(
      "SELECT id, ticket, agreed, votes_json, completed_at FROM rounds WHERE board_id = ? ORDER BY completed_at ASC",
    )
    .bind(boardId)
    .all<{
      id: string;
      ticket: string;
      agreed: string;
      votes_json: string;
      completed_at: string;
    }>();
  const rounds: CompletedRound[] = rows.results.map((row) => ({
    id: row.id,
    ticket: row.ticket,
    agreed: row.agreed,
    votes: JSON.parse(row.votes_json) as VoteRecord[],
    completed_at: row.completed_at,
  }));
  return { id: board.id, name: board.name, rounds };
}
