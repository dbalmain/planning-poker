/** Sessions unused for this long, including their history, are deleted. */
export const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export function staleCutoff(now = Date.now()): string {
  return new Date(now - SESSION_TTL_MS).toISOString();
}

/** Players with no live connection for this long are removed from the table. */
export const PRESENCE_TTL_MS = 5 * 60 * 1000;

/** How often an open tab proves it is still there. */
export const HEARTBEAT_INTERVAL_MS = 60 * 1000;

/** Answered by the runtime without waking the room. */
export const PING = "ping";
export const PONG = "pong";

/** Close code for a join the server will not accept; the client stops retrying. */
export const JOIN_REFUSED = 4001;
