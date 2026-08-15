export const enum ErrorStatus {
  BadRequest = 400,
  NotFound = 404,
  Conflict = 409,
}

export class AppError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "AppError";
    this.status = status;
  }
}

export const Errors = {
  boardNotFound: () => new AppError("board not found", ErrorStatus.NotFound),
  notJoined: () => new AppError("join the table first", ErrorStatus.Conflict),
  spectator: () => new AppError("spectators cannot vote", ErrorStatus.Conflict),
  unknownCard: () => new AppError("that card is not in this deck", ErrorStatus.Conflict),
  unknownDeck: () => new AppError("unknown deck", ErrorStatus.BadRequest),
  alreadyRevealed: () => new AppError("cards are already revealed", ErrorStatus.Conflict),
  notRevealed: () => new AppError("cards are still hidden", ErrorStatus.Conflict),
  votesLocked: () => new AppError("votes are locked", ErrorStatus.Conflict),
  notChoosing: () => new AppError("click Pick Agreed Estimate first", ErrorStatus.Conflict),
  noEstimate: () => new AppError("pick an agreed estimate first", ErrorStatus.Conflict),
  noTicket: () => new AppError("give this round a ticket name", ErrorStatus.Conflict),
  emptyName: () => new AppError("name cannot be empty", ErrorStatus.BadRequest),
  nameTooLong: () => new AppError("name is too long", ErrorStatus.BadRequest),
  ticketTooLong: () => new AppError("ticket is too long", ErrorStatus.BadRequest),
  boardNameTooLong: () => new AppError("session name is too long", ErrorStatus.BadRequest),
  invalidPlayerId: () => new AppError("invalid player id", ErrorStatus.BadRequest),
  invalidJson: () => new AppError("invalid JSON body", ErrorStatus.BadRequest),
} as const;

export function errorBody(error: unknown): { error: string; status: number } {
  if (error instanceof AppError) {
    return { error: error.message, status: error.status };
  }
  return { error: "internal error", status: 500 };
}
