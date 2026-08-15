import {
  array,
  assert,
  boolean,
  constant,
  constantFrom,
  integer,
  oneof,
  property,
  record,
} from "fast-check";
import { describe, expect, it } from "vitest";
import { ALL_DECKS, FIBONACCI, isOpenCard, parseDeck } from "../../shared/deck.ts";
import { AppError } from "../../shared/errors.ts";
import { Board } from "../../shared/game.ts";

/** Default stays in the milliseconds. `FC_NUM_RUNS=500 npm test` for a longer pass. */
const NUM_RUNS = parseRuns(
  (process as { env: Record<string, string | undefined> }).env.FC_NUM_RUNS,
);

const NAMES = ["Ann", "Bo", "Cam", "Dot", "Ed"] as const;
const [firstDeckId, ...restDeckIds] = ALL_DECKS.map((deck) => deck.id);
const [firstCard, ...restCards] = unique(ALL_DECKS.flatMap((deck) => [...deck.cards]));

type Op =
  | { type: "join"; player: number; name: string; spectator: boolean }
  | { type: "vote"; player: number; card: string }
  | { type: "reveal" }
  | { type: "revote"; player: number }
  | { type: "set_spectator"; player: number; spectator: boolean }
  | { type: "set_deck"; player: number; deck: string };

describe("board properties", () => {
  it("round-trips snapshot through toJSON/fromJSON", () => {
    assert(
      property(scenarios(), ({ playerCount, ops }) => {
        const { board, ids } = seated(playerCount);
        checkRoundTrip(board);
        for (const op of ops) {
          tryApply(board, ids, op);
          checkRoundTrip(board);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("hides numeric votes from other players while voting", () => {
    assert(
      property(scenarios(), ({ playerCount, ops }) => {
        const { board, ids } = seated(playerCount);
        checkVoteSecrecy(board);
        for (const op of ops) {
          tryApply(board, ids, op);
          checkVoteSecrecy(board);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

function scenarios() {
  return integer({ min: 2, max: 4 }).chain((playerCount) =>
    record({
      playerCount: constant(playerCount),
      ops: array(opsFor(playerCount), { minLength: 0, maxLength: 16 }),
    }),
  );
}

function opsFor(playerCount: number) {
  if (firstCard === undefined || firstDeckId === undefined) {
    throw new Error("decks must define at least one card and one id");
  }
  const player = integer({ min: 0, max: playerCount - 1 });
  return oneof(
    record({
      type: constant("join" as const),
      player,
      name: constantFrom(...NAMES),
      spectator: boolean(),
    }),
    record({
      type: constant("vote" as const),
      player,
      card: constantFrom(firstCard, ...restCards),
    }),
    constant({ type: "reveal" as const } satisfies Op),
    record({
      type: constant("revote" as const),
      player,
    }),
    record({
      type: constant("set_spectator" as const),
      player,
      spectator: boolean(),
    }),
    record({
      type: constant("set_deck" as const),
      player,
      deck: constantFrom(firstDeckId, ...restDeckIds),
    }),
  );
}

function seated(playerCount: number): { board: Board; ids: string[] } {
  const board = Board.create("b", "Sprint", FIBONACCI);
  const ids = Array.from({ length: playerCount }, (_, i) => pid(i + 1));
  for (const [i, id] of ids.entries()) {
    board.join(id, NAMES[i] ?? `P${i}`, false);
  }
  return { board, ids };
}

function tryApply(board: Board, ids: readonly string[], op: Op): void {
  try {
    switch (op.type) {
      case "join":
        board.join(playerOf(ids, op.player), op.name, op.spectator);
        return;
      case "vote":
        board.vote(playerOf(ids, op.player), op.card);
        return;
      case "reveal":
        board.reveal();
        return;
      case "revote":
        board.revote(playerOf(ids, op.player));
        return;
      case "set_spectator":
        board.setSpectator(playerOf(ids, op.player), op.spectator);
        return;
      case "set_deck":
        board.setDeck(playerOf(ids, op.player), parseDeck(op.deck));
        return;
    }
  } catch (error) {
    if (error instanceof AppError) {
      return;
    }
    throw error;
  }
}

function checkRoundTrip(board: Board): void {
  const copy = Board.fromJSON(board.toJSON());
  for (const id of board.players.keys()) {
    expect(copy.snapshot(id)).toEqual(board.snapshot(id));
  }
}

function checkVoteSecrecy(board: Board): void {
  if (board.phase !== "voting") {
    return;
  }
  for (const viewer of board.players.keys()) {
    const snap = board.snapshot(viewer);
    for (const other of snap.players) {
      if (other.id === viewer) {
        continue;
      }
      const actual = board.votes.get(other.id);
      if (actual !== undefined && isOpenCard(actual)) {
        expect(other.vote).toBe(actual);
      } else {
        expect(other.vote).toBeNull();
      }
    }
  }
}

function playerOf(ids: readonly string[], index: number): string {
  const id = ids[index];
  if (id === undefined) {
    throw new Error(`player index ${index} out of range`);
  }
  return id;
}

function pid(n: number): string {
  return n.toString(16).padStart(32, "0");
}

function unique(items: string[]): string[] {
  return [...new Set(items)];
}

function parseRuns(raw: string | undefined): number {
  if (raw === undefined || raw === "") {
    return 40;
  }
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 40;
}
