export type {
  BoardMeta,
  ClientMsg,
  CompletedRound,
  DeckInfo,
  HistoryResponse,
  Phase,
  PlayerView,
  ServerMsg,
  Snapshot,
  VoteRecord,
} from "../shared/protocol.ts";
export { isOpenCard } from "../shared/deck.ts";
export { isHexId as isPlayerId, randomId as newPlayerId } from "../shared/id.ts";

export type Seat = {
  playerId: string;
  name: string;
  spectator: boolean;
};

const SEAT_PREFIX = "planning-poker:seat:";
const NAME_KEY = "planning-poker:last-name";

export function loadSeat(boardId: string): Seat | null {
  const raw = localStorage.getItem(SEAT_PREFIX + boardId);
  if (!raw) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "playerId" in parsed &&
      "name" in parsed &&
      "spectator" in parsed &&
      typeof parsed.playerId === "string" &&
      typeof parsed.name === "string" &&
      typeof parsed.spectator === "boolean"
    ) {
      return {
        playerId: parsed.playerId,
        name: parsed.name,
        spectator: parsed.spectator,
      };
    }
  } catch {
    return null;
  }
  return null;
}

export function saveSeat(boardId: string, seat: Seat): void {
  localStorage.setItem(SEAT_PREFIX + boardId, JSON.stringify(seat));
  localStorage.setItem(NAME_KEY, seat.name);
}

export function lastName(): string {
  return localStorage.getItem(NAME_KEY) ?? "";
}

/** Coffee sits this round out — same as watching for the voter tally. */
export function isVoter(player: { spectator: boolean; vote: string | null }): boolean {
  return !player.spectator && player.vote !== "☕";
}

/** A real estimate. `?` is still a voter but not a vote. */
export function hasEstimate(player: {
  spectator: boolean;
  vote: string | null;
  has_voted: boolean;
}): boolean {
  if (!isVoter(player) || player.vote === "?") {
    return false;
  }
  return player.has_voted;
}
