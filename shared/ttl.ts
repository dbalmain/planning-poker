/** Sessions unused for this long, including their history, are deleted. */
export const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export function staleCutoff(now = Date.now()): string {
  return new Date(now - SESSION_TTL_MS).toISOString();
}
