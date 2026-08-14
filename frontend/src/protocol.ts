export type Phase = "voting" | "revealed" | "choosing";

export type PlayerView = {
  id: string;
  name: string;
  spectator: boolean;
  connected: boolean;
  has_voted: boolean;
  vote: string | null;
};

export type VoteRecord = {
  name: string;
  card: string | null;
};

export type CompletedRound = {
  id: string;
  ticket: string;
  agreed: string;
  votes: VoteRecord[];
  completed_at: string;
};

export type Snapshot = {
  board_id: string;
  board_name: string;
  deck_id: string;
  cards: string[];
  ticket: string;
  phase: Phase;
  proposed_estimate: string | null;
  players: PlayerView[];
  you: PlayerView;
  completed: CompletedRound[];
  average: number | null;
};

export type ClientMsg =
  | { type: "join"; player_id: string; name: string; spectator: boolean }
  | { type: "set_ticket"; ticket: string }
  | { type: "vote"; card: string }
  | { type: "reveal" }
  | { type: "pick_estimate" }
  | { type: "set_estimate"; card: string }
  | { type: "confirm_round" }
  | { type: "revote" }
  | { type: "set_spectator"; spectator: boolean }
  | { type: "set_deck"; deck: string };

export type HistoryResponse = {
  id: string;
  name: string;
  rounds: CompletedRound[];
};

export type Route =
  | { kind: "create" }
  | { kind: "board"; boardId: string }
  | { kind: "history"; boardId: string }
  | { kind: "not_found" };

export type ServerMsg =
  | { type: "welcome"; player_id: string; state: Snapshot }
  | { type: "state"; state: Snapshot }
  | { type: "error"; message: string };

export type BoardMeta = {
  id: string;
  name: string;
  deck: string;
};

export type DeckInfo = {
  id: string;
  label: string;
  preview: string;
};

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

export function newPlayerId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function parseRoute(pathname: string): Route {
  if (pathname === "/" || pathname === "") {
    return { kind: "create" };
  }
  const history = /^\/b\/([0-9a-f]{32})\/history\/?$/i.exec(pathname);
  if (history?.[1]) {
    return { kind: "history", boardId: history[1] };
  }
  const board = /^\/b\/([0-9a-f]{32})\/?$/i.exec(pathname);
  if (board?.[1]) {
    return { kind: "board", boardId: board[1] };
  }
  return { kind: "not_found" };
}

export function isOpenCard(card: string): boolean {
  return card === "?" || card === "☕";
}

/** Coffee sits this round out — same as watching for the voter tally. */
export function isVoter(player: PlayerView): boolean {
  return !player.spectator && player.vote !== "☕";
}

/** A real estimate. `?` is still a voter but not a vote. */
export function hasEstimate(player: PlayerView): boolean {
  if (!isVoter(player) || player.vote === "?") {
    return false;
  }
  return player.has_voted;
}
