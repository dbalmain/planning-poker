import { deckContains, isOpenCard, parseDeck, parseNumeric, type Deck } from "./deck.ts";
import { Errors } from "./errors.ts";
import { isHexId, randomId } from "./id.ts";
import type { ClientMsg, CompletedRound, Phase, PlayerView, Snapshot, VoteRecord } from "./protocol.ts";

type BoardMessage = Exclude<ClientMsg, { type: "confirm_round" }>;

export const MAX_NAME_LEN = 40;
export const MAX_TICKET_LEN = 80;
export const MAX_BOARD_NAME_LEN = 80;

export type Player = {
  id: string;
  name: string;
  spectator: boolean;
  connected: boolean;
};

export type SerializedBoard = {
  id: string;
  name: string;
  deck: string;
  ticket: string;
  phase: Phase;
  players: Player[];
  votes: [string, string][];
  proposedEstimate: string | null;
};

export class Board {
  id: string;
  name: string;
  deck: Deck;
  ticket: string;
  phase: Phase;
  players: Map<string, Player>;
  votes: Map<string, string>;
  proposedEstimate: string | null;

  constructor(init: {
    id: string;
    name: string;
    deck: Deck;
    ticket?: string;
    phase?: Phase;
    players?: Map<string, Player>;
    votes?: Map<string, string>;
    proposedEstimate?: string | null;
  }) {
    this.id = init.id;
    this.name = init.name;
    this.deck = init.deck;
    this.ticket = init.ticket ?? "";
    this.phase = init.phase ?? "voting";
    this.players = init.players ?? new Map();
    this.votes = init.votes ?? new Map();
    this.proposedEstimate = init.proposedEstimate ?? null;
  }

  static create(id: string, name: string, deck: Deck): Board {
    return new Board({ id, name: normalizeBoardName(name), deck });
  }

  static fromJSON(data: SerializedBoard): Board {
    return new Board({
      id: data.id,
      name: data.name,
      deck: parseDeck(data.deck),
      ticket: data.ticket,
      phase: data.phase,
      players: new Map(data.players.map((player) => [player.id, player])),
      votes: new Map(data.votes),
      proposedEstimate: data.proposedEstimate,
    });
  }

  toJSON(): SerializedBoard {
    return {
      id: this.id,
      name: this.name,
      deck: this.deck.id,
      ticket: this.ticket,
      phase: this.phase,
      players: [...this.players.values()],
      votes: [...this.votes.entries()],
      proposedEstimate: this.proposedEstimate,
    };
  }

  join(playerId: string, name: string, spectator: boolean): void {
    if (!isHexId(playerId)) {
      throw Errors.invalidPlayerId();
    }
    const normalized = normalizeName(name);
    const existing = this.players.get(playerId);
    if (existing) {
      existing.name = normalized;
      existing.connected = true;
      if (existing.spectator !== spectator) {
        this.setSpectator(playerId, spectator);
      }
      return;
    }
    this.players.set(playerId, {
      id: playerId,
      name: normalized,
      spectator,
      connected: true,
    });
  }

  disconnect(playerId: string): void {
    const player = this.players.get(playerId);
    if (player) {
      player.connected = false;
    }
  }

  setTicket(ticket: string): void {
    const trimmed = ticket.trim();
    if (trimmed.length > MAX_TICKET_LEN) {
      throw Errors.ticketTooLong();
    }
    this.ticket = trimmed;
  }

  setDeck(playerId: string, deck: Deck): void {
    this.requirePlayer(playerId);
    this.deck = deck;
    for (const [id, card] of this.votes) {
      if (!deckContains(deck, card)) {
        this.votes.delete(id);
      }
    }
    if (this.proposedEstimate !== null && !deckContains(deck, this.proposedEstimate)) {
      this.proposedEstimate = null;
    }
  }

  vote(playerId: string, card: string): void {
    const player = this.players.get(playerId);
    if (!player) {
      throw Errors.notJoined();
    }
    if (player.spectator) {
      throw Errors.spectator();
    }
    if (this.phase === "choosing") {
      throw Errors.votesLocked();
    }
    if (!deckContains(this.deck, card)) {
      throw Errors.unknownCard();
    }
    this.votes.set(playerId, card);
  }

  reveal(): void {
    if (this.phase !== "voting") {
      throw Errors.alreadyRevealed();
    }
    this.phase = "revealed";
  }

  pickEstimate(playerId: string): void {
    this.requirePlayer(playerId);
    if (this.phase === "revealed") {
      this.phase = "choosing";
      return;
    }
    if (this.phase === "choosing") {
      return;
    }
    throw Errors.notRevealed();
  }

  setEstimate(playerId: string, card: string): void {
    this.requirePlayer(playerId);
    if (this.phase !== "choosing") {
      throw Errors.notChoosing();
    }
    if (!deckContains(this.deck, card)) {
      throw Errors.unknownCard();
    }
    this.proposedEstimate = card;
  }

  /** Validate and build the history row without touching live state. */
  buildCompletedRound(playerId: string): CompletedRound {
    this.requirePlayer(playerId);
    if (this.phase !== "choosing") {
      throw this.phase === "revealed" ? Errors.notChoosing() : Errors.notRevealed();
    }
    const ticket = this.ticket.trim();
    if (ticket.length === 0) {
      throw Errors.noTicket();
    }
    if (this.proposedEstimate === null) {
      throw Errors.noEstimate();
    }
    return {
      id: randomId(),
      ticket,
      agreed: this.proposedEstimate,
      votes: this.voterRecords(),
      completed_at: new Date().toISOString(),
    };
  }

  /** Drop the live ticket after its result is stored in history. */
  startNextTicket(): void {
    this.resetRound();
    this.pruneDisconnected();
  }

  revote(playerId: string): void {
    this.requirePlayer(playerId);
    if (!this.faceUp()) {
      throw Errors.notRevealed();
    }
    for (const [id, card] of this.votes) {
      if (card !== "☕") {
        this.votes.delete(id);
      }
    }
    this.proposedEstimate = null;
    this.phase = "voting";
    this.pruneDisconnected();
  }

  setSpectator(playerId: string, spectator: boolean): void {
    const player = this.players.get(playerId);
    if (!player) {
      throw Errors.notJoined();
    }
    player.spectator = spectator;
    if (spectator) {
      this.votes.delete(playerId);
    }
  }

  snapshot(viewerId: string): Snapshot {
    const you = this.players.get(viewerId);
    if (!you) {
      throw Errors.notJoined();
    }
    const players = [...this.players.values()]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((player) => this.playerView(player, viewerId));
    return {
      board_id: this.id,
      board_name: this.name,
      deck_id: this.deck.id,
      cards: [...this.deck.cards],
      ticket: this.ticket,
      phase: this.phase,
      proposed_estimate: this.proposedEstimate,
      players,
      you: this.playerView(you, viewerId),
      completed: [],
      average: this.average(),
    };
  }

  apply(playerId: string, msg: BoardMessage): void {
    switch (msg.type) {
      case "join":
        this.join(playerId, msg.name, msg.spectator);
        return;
      case "set_ticket":
        this.setTicket(msg.ticket);
        return;
      case "vote":
        this.vote(playerId, msg.card);
        return;
      case "reveal":
        this.reveal();
        return;
      case "pick_estimate":
        this.pickEstimate(playerId);
        return;
      case "set_estimate":
        this.setEstimate(playerId, msg.card);
        return;
      case "revote":
        this.revote(playerId);
        return;
      case "set_spectator":
        this.setSpectator(playerId, msg.spectator);
        return;
      case "set_deck":
        this.setDeck(playerId, parseDeck(msg.deck));
        return;
    }
  }

  private playerView(player: Player, viewerId: string): PlayerView {
    const vote = this.votes.get(player.id) ?? null;
    const showVote =
      this.faceUp() || player.id === viewerId || (vote !== null && isOpenCard(vote));
    return {
      id: player.id,
      name: player.name,
      spectator: player.spectator,
      connected: player.connected,
      has_voted: vote !== null,
      vote: showVote ? vote : null,
    };
  }

  private average(): number | null {
    if (!this.faceUp()) {
      return null;
    }
    const nums: number[] = [];
    for (const card of this.votes.values()) {
      const value = parseNumeric(card);
      if (value !== null) {
        nums.push(value);
      }
    }
    if (nums.length === 0) {
      return null;
    }
    return nums.reduce((sum, n) => sum + n, 0) / nums.length;
  }

  private voterRecords(): VoteRecord[] {
    return [...this.players.values()]
      .filter((player) => !player.spectator)
      .map((player) => ({
        name: player.name,
        card: this.votes.get(player.id) ?? null,
      }));
  }

  private resetRound(): void {
    this.ticket = "";
    this.votes.clear();
    this.proposedEstimate = null;
    this.phase = "voting";
  }

  private pruneDisconnected(): void {
    for (const [id, player] of this.players) {
      if (!player.connected) {
        this.players.delete(id);
        this.votes.delete(id);
      }
    }
  }

  private requirePlayer(playerId: string): void {
    if (!this.players.has(playerId)) {
      throw Errors.notJoined();
    }
  }

  private faceUp(): boolean {
    return this.phase === "revealed" || this.phase === "choosing";
  }
}

export function normalizeName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw Errors.emptyName();
  }
  if (trimmed.length > MAX_NAME_LEN) {
    throw Errors.nameTooLong();
  }
  return trimmed;
}

export function normalizeBoardName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length > MAX_BOARD_NAME_LEN) {
    throw Errors.boardNameTooLong();
  }
  return trimmed.length === 0 ? "Planning session" : trimmed;
}
