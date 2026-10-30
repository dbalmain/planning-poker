import { describe, expect, it } from "vitest";
import { isHexId, randomId, seatId } from "../../shared/id.ts";

describe("ids", () => {
  it("are 32 hex chars", () => {
    const id = randomId();
    expect(id).toHaveLength(32);
    expect(isHexId(id)).toBe(true);
  });

  it("are unique across a batch", () => {
    const ids = new Set(Array.from({ length: 256 }, () => randomId()));
    expect(ids.size).toBe(256);
  });

  it("rejects short or non-hex ids", () => {
    expect(isHexId("abc")).toBe(false);
    expect(isHexId("g".repeat(32))).toBe(false);
    expect(isHexId("a".repeat(31))).toBe(false);
    expect(isHexId("A".repeat(32))).toBe(false);
  });

  it("seat ids are the first 128 bits of SHA-256 of the secret", async () => {
    const secret = "0".repeat(32);
    const id = await seatId(secret);
    expect(id).toBe("84e0c0eafaa95a34c293f278ac52e45c");
    expect(isHexId(id)).toBe(true);
    expect(await seatId(id)).not.toBe(id);
  });
});
