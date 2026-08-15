import { describe, expect, it } from "vitest";
import {
  ALL_DECKS,
  FIBONACCI,
  MODIFIED_FIBONACCI,
  POWERS_OF_TWO,
  deckContains,
  parseDeck,
  parseNumeric,
} from "../shared/deck.ts";
import { AppError } from "../shared/errors.ts";

describe("decks", () => {
  it("every deck has question and coffee", () => {
    for (const deck of ALL_DECKS) {
      expect(deckContains(deck, "?"), deck.id).toBe(true);
      expect(deckContains(deck, "☕"), deck.id).toBe(true);
    }
  });

  it("parse rejects unknown", () => {
    expect(() => parseDeck("scrabble")).toThrow(AppError);
    expect(parseDeck("fibonacci").id).toBe("fibonacci");
  });

  it("fibonacci includes half and stops at 21", () => {
    expect(deckContains(FIBONACCI, "½")).toBe(true);
    expect(deckContains(FIBONACCI, "21")).toBe(true);
    expect(deckContains(FIBONACCI, "34")).toBe(false);
    expect(deckContains(FIBONACCI, "55")).toBe(false);
    expect(deckContains(FIBONACCI, "89")).toBe(false);
  });

  it("modified fibonacci stops at 20", () => {
    expect(deckContains(MODIFIED_FIBONACCI, "20")).toBe(true);
    expect(deckContains(MODIFIED_FIBONACCI, "40")).toBe(false);
    expect(deckContains(MODIFIED_FIBONACCI, "100")).toBe(false);
  });

  it("powers of two stops at 32", () => {
    expect(deckContains(POWERS_OF_TWO, "32")).toBe(true);
    expect(deckContains(POWERS_OF_TWO, "64")).toBe(false);
  });

  it("half is numeric", () => {
    expect(parseNumeric("½")).toBe(0.5);
    expect(parseNumeric("8")).toBe(8);
    expect(parseNumeric("?")).toBeNull();
    expect(parseNumeric("☕")).toBeNull();
    expect(parseNumeric("M")).toBeNull();
  });
});
