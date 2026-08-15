import { Errors } from "./errors.ts";

export type Deck = {
  id: string;
  label: string;
  cards: readonly string[];
};

export const FIBONACCI: Deck = {
  id: "fibonacci",
  label: "Fibonacci",
  cards: ["0", "½", "1", "2", "3", "5", "8", "13", "21", "?", "☕"],
};

export const MODIFIED_FIBONACCI: Deck = {
  id: "modified_fibonacci",
  label: "Modified Fibonacci",
  cards: ["0", "½", "1", "2", "3", "5", "8", "13", "20", "?", "☕"],
};

export const POWERS_OF_TWO: Deck = {
  id: "powers_of_two",
  label: "Powers of 2",
  cards: ["0", "1", "2", "4", "8", "16", "32", "?", "☕"],
};

export const TSHIRT: Deck = {
  id: "tshirt",
  label: "T-shirt",
  cards: ["XS", "S", "M", "L", "XL", "XXL", "?", "☕"],
};

export const ALL_DECKS: readonly Deck[] = [
  FIBONACCI,
  MODIFIED_FIBONACCI,
  POWERS_OF_TWO,
  TSHIRT,
];

export function parseDeck(id: string): Deck {
  const deck = ALL_DECKS.find((item) => item.id === id);
  if (!deck) {
    throw Errors.unknownDeck();
  }
  return deck;
}

export function deckContains(deck: Deck, card: string): boolean {
  return deck.cards.includes(card);
}

export function deckPreview(deck: Deck): string {
  return `${deck.label} (${deck.cards.join(", ")})`;
}

export function listDecks(): { id: string; label: string; preview: string }[] {
  return ALL_DECKS.map((deck) => ({
    id: deck.id,
    label: deck.label,
    preview: deckPreview(deck),
  }));
}

/** `?` and coffee are signals, not estimates — everyone sees them immediately. */
export function isOpenCard(card: string): boolean {
  return card === "?" || card === "☕";
}

export function parseNumeric(card: string): number | null {
  if (card === "½") {
    return 0.5;
  }
  const value = Number(card);
  return Number.isFinite(value) ? value : null;
}
