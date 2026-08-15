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

export type ServerMsg =
  | { type: "welcome"; player_id: string; state: Snapshot }
  | { type: "state"; state: Snapshot }
  | { type: "error"; message: string };

export type HistoryResponse = {
  id: string;
  name: string;
  rounds: CompletedRound[];
};

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

export type CreateBoardRequest = {
  name?: string;
  deck: string;
};
