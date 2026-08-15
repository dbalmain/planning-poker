import { staleCutoff } from "../shared/ttl.ts";

export type StaleBoardRow = { id: string };

export const CLEANUP_BATCH_SIZE = 100;
export const CLEANUP_MAX_BATCHES = 10;

export async function deleteStaleBoards(
  db: D1Database,
  now = Date.now(),
  limit = CLEANUP_BATCH_SIZE,
): Promise<string[]> {
  const cutoff = staleCutoff(now);
  const deleted = await db
    .prepare(
      `DELETE FROM boards
       WHERE id IN (
         SELECT id FROM boards
         WHERE last_used_at < ?
         ORDER BY last_used_at, id
         LIMIT ?
       )
       RETURNING id`,
    )
    .bind(cutoff, limit)
    .all<StaleBoardRow>();
  return deleted.results.map((row) => row.id);
}
