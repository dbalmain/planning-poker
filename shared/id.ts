const HEX = "0123456789abcdef";

/** 128-bit unguessable id, lowercase hex (32 characters). */
export function randomId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}

/**
 * Public player id for a seat secret. Ids are broadcast to the table, so a
 * seat is claimed by presenting the secret, never the id.
 */
export async function seatId(secret: string): Promise<string> {
  return hashId(secret);
}

/** First 128 bits of SHA-256(text), as a hex id. */
export async function hashId(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return toHex(new Uint8Array(digest).subarray(0, 16));
}

export function isHexId(id: string): boolean {
  return id.length === 32 && /^[0-9a-f]+$/.test(id);
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) {
    out += HEX[byte >> 4] ?? "";
    out += HEX[byte & 0x0f] ?? "";
  }
  return out;
}
