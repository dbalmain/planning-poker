import { describe, expect, it } from "vitest";
import { FIBONACCI, POWERS_OF_TWO, TSHIRT } from "../../shared/deck.ts";
import { AppError } from "../../shared/errors.ts";
import { Board } from "../../shared/game.ts";

function pid(n: number): string {
  return n.toString(16).padStart(32, "0");
}

function seated(): { board: Board; dave: string; sam: string } {
  const board = Board.create("b", "Sprint", FIBONACCI);
  const dave = pid(1);
  const sam = pid(2);
  board.join(dave, "Dave", false);
  board.join(sam, "Sam", false);
  return { board, dave, sam };
}

describe("board", () => {
  it("empty session name defaults", () => {
    const board = Board.create("b", "  ", FIBONACCI);
    expect(board.name).toBe("Planning session");
  });

  it("votes stay hidden until reveal", () => {
    const { board, dave, sam } = seated();
    board.vote(dave, "5");
    board.vote(sam, "8");

    const daveView = board.snapshot(dave);
    const samFromDave = daveView.players.find((p) => p.id === sam);
    expect(samFromDave?.has_voted).toBe(true);
    expect(samFromDave?.vote).toBeNull();
    expect(daveView.you.vote).toBe("5");
    expect(daveView.average).toBeNull();

    board.reveal();
    const revealed = board.snapshot(dave);
    expect(revealed.players.find((p) => p.id === sam)?.vote).toBe("8");
    expect(revealed.average).toBe(6.5);
  });

  it("can change vote before reveal", () => {
    const { board, dave } = seated();
    board.vote(dave, "3");
    board.vote(dave, "13");
    expect(board.votes.get(dave)).toBe("13");
  });

  it("can change vote after reveal", () => {
    const { board, dave } = seated();
    board.vote(dave, "5");
    board.reveal();
    board.vote(dave, "8");
    expect(board.votes.get(dave)).toBe("8");
    const view = board.snapshot(dave);
    expect(view.you.vote).toBe("8");
    expect(view.average).toBe(8);
  });

  it("cannot vote while choosing", () => {
    const { board, dave } = seated();
    board.vote(dave, "5");
    board.reveal();
    board.pickEstimate(dave);
    expect(() => board.vote(dave, "8")).toThrow(AppError);
    expect(() => board.vote(dave, "8")).toThrow("votes are locked");
  });

  it("spectator cannot vote and is excluded from records", () => {
    const { board, dave, sam } = seated();
    board.setSpectator(sam, true);
    expect(() => board.vote(sam, "5")).toThrow("spectators cannot vote");
    board.vote(dave, "5");
    board.setTicket("PROJ-1");
    board.reveal();
    board.pickEstimate(dave);
    board.setEstimate(dave, "5");
    const round = board.buildCompletedRound(dave);
    board.startNextTicket();
    expect(round.votes).toHaveLength(1);
    expect(round.votes[0]?.name).toBe("Dave");
    expect(round.votes[0]?.card).toBe("5");
  });

  it("becoming spectator clears a vote", () => {
    const { board, dave } = seated();
    board.vote(dave, "8");
    board.setSpectator(dave, true);
    expect(board.votes.has(dave)).toBe(false);
  });

  it("confirm requires ticket and estimate, then throws live state away", () => {
    const { board, dave } = seated();
    board.vote(dave, "5");
    board.reveal();
    expect(() => board.buildCompletedRound(dave)).toThrow(
      "click Pick Agreed Estimate first",
    );
    board.pickEstimate(dave);
    expect(() => board.buildCompletedRound(dave)).toThrow(
      "give this round a ticket name",
    );
    board.setTicket("PROJ-9");
    expect(() => board.buildCompletedRound(dave)).toThrow(
      "pick an agreed estimate first",
    );
    board.setEstimate(dave, "5");
    const round = board.buildCompletedRound(dave);
    board.startNextTicket();
    expect(round.ticket).toBe("PROJ-9");
    expect(round.agreed).toBe("5");
    expect(board.phase).toBe("voting");
    expect(board.ticket).toBe("");
    expect(board.votes.size).toBe(0);
    expect(board.proposedEstimate).toBeNull();
    expect(board.snapshot(dave).completed).toEqual([]);
  });

  it("confirm records non-voters", () => {
    const { board, dave } = seated();
    board.vote(dave, "3");
    board.setTicket("T-1");
    board.reveal();
    board.pickEstimate(dave);
    board.setEstimate(dave, "3");
    const round = board.buildCompletedRound(dave);
    board.startNextTicket();
    expect(round.votes.find((v) => v.name === "Sam")?.card).toBeNull();
  });

  it("revote hides cards again", () => {
    const { board, dave } = seated();
    board.vote(dave, "2");
    board.reveal();
    board.revote(dave);
    expect(board.phase).toBe("voting");
    expect(board.votes.size).toBe(0);
    expect(board.proposedEstimate).toBeNull();
  });

  it("revote keeps coffee", () => {
    const { board, dave, sam } = seated();
    board.vote(dave, "☕");
    board.vote(sam, "8");
    board.reveal();
    board.revote(dave);
    expect(board.phase).toBe("voting");
    expect(board.votes.get(dave)).toBe("☕");
    expect(board.votes.has(sam)).toBe(false);
  });

  it("unknown card is rejected", () => {
    const { board, dave } = seated();
    expect(() => board.vote(dave, "99")).toThrow("that card is not in this deck");
  });

  it("rejoin reclaims the same seat", () => {
    const { board, dave } = seated();
    board.vote(dave, "5");
    board.disconnect(dave);
    board.join(dave, "David", false);
    expect(board.players.get(dave)?.name).toBe("David");
    expect(board.players.get(dave)?.connected).toBe(true);
    expect(board.votes.get(dave)).toBe("5");
  });

  it("confirm drops disconnected players", () => {
    const { board, dave, sam } = seated();
    board.vote(dave, "5");
    board.disconnect(sam);
    board.setTicket("X");
    board.reveal();
    board.pickEstimate(dave);
    board.setEstimate(dave, "5");
    board.buildCompletedRound(dave);
    board.startNextTicket();
    expect(board.players.has(sam)).toBe(false);
    expect(board.players.has(dave)).toBe(true);
  });

  it("question and coffee are visible before reveal", () => {
    const { board, dave, sam } = seated();
    board.vote(dave, "?");
    board.vote(sam, "☕");
    const daveView = board.snapshot(dave);
    expect(daveView.players.find((p) => p.id === sam)?.vote).toBe("☕");
    expect(daveView.you.vote).toBe("?");
  });

  it("numeric votes stay hidden when a signal is showing", () => {
    const { board, dave, sam } = seated();
    board.vote(dave, "?");
    board.vote(sam, "8");
    const daveView = board.snapshot(dave);
    const samFromDave = daveView.players.find((p) => p.id === sam);
    expect(samFromDave?.has_voted).toBe(true);
    expect(samFromDave?.vote).toBeNull();
  });

  it("set deck drops cards that are not in the new deck", () => {
    const { board, dave, sam } = seated();
    board.vote(dave, "8");
    board.vote(sam, "13");
    board.setDeck(dave, POWERS_OF_TWO);
    expect(board.deck.id).toBe("powers_of_two");
    expect(board.votes.get(dave)).toBe("8");
    expect(board.votes.has(sam)).toBe(false);
  });

  it("fibonacci accepts a half", () => {
    const { board, dave } = seated();
    board.vote(dave, "½");
    expect(board.votes.get(dave)).toBe("½");
  });

  it("anyone at the table can reveal", () => {
    const { board, dave, sam } = seated();
    board.vote(dave, "1");
    board.reveal();
    expect(board.phase).toBe("revealed");
    board.revote(sam);
    expect(board.phase).toBe("voting");
  });

  it("pick estimate locks votes and unlocks save", () => {
    const { board, dave, sam } = seated();
    board.vote(dave, "5");
    board.vote(sam, "8");
    board.setTicket("T-2");
    board.reveal();
    board.vote(sam, "5");
    expect(board.snapshot(dave).average).toBe(5);
    board.pickEstimate(dave);
    expect(board.phase).toBe("choosing");
    board.setEstimate(sam, "5");
    expect(board.proposedEstimate).toBe("5");
    const round = board.buildCompletedRound(dave);
    board.startNextTicket();
    expect(round.agreed).toBe("5");
    expect(round.votes).toHaveLength(2);
  });

  it("cannot set estimate during discussion", () => {
    const { board, dave } = seated();
    board.vote(dave, "5");
    board.reveal();
    expect(() => board.setEstimate(dave, "5")).toThrow(
      "click Pick Agreed Estimate first",
    );
  });

  it("round-trips live state without history", () => {
    const { board, dave } = seated();
    board.setTicket("PROJ-1");
    board.vote(dave, "8");
    const copy = Board.fromJSON(board.toJSON());
    expect(copy.ticket).toBe("PROJ-1");
    expect(copy.votes.get(dave)).toBe("8");
    expect(copy.players.get(dave)?.name).toBe("Dave");
    copy.setDeck(dave, TSHIRT);
    expect(copy.deck.id).toBe("tshirt");
  });
});
