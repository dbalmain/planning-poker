const HEX = "0123456789abcdef";

/** 128-bit unguessable id, lowercase hex (32 characters). */
export function randomId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
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
