#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("board not found")]
    BoardNotFound,
    #[error("join the table first")]
    NotJoined,
    #[error("spectators cannot vote")]
    Spectator,
    #[error("that card is not in this deck")]
    UnknownCard,
    #[error("unknown deck")]
    UnknownDeck,
    #[error("cards are already revealed")]
    AlreadyRevealed,
    #[error("cards are still hidden")]
    NotRevealed,
    #[error("votes are locked")]
    VotesLocked,
    #[error("click Pick Agreed Estimate first")]
    NotChoosing,
    #[error("pick an agreed estimate first")]
    NoEstimate,
    #[error("give this round a ticket name")]
    NoTicket,
    #[error("name cannot be empty")]
    EmptyName,
    #[error("name is too long")]
    NameTooLong,
    #[error("ticket is too long")]
    TicketTooLong,
    #[error("session name is too long")]
    BoardNameTooLong,
    #[error("invalid player id")]
    InvalidPlayerId,
    #[error("{0}")]
    Config(String),
    #[error("database error: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("database task cancelled")]
    DbTask,
    #[error("invalid data: {0}")]
    Json(#[from] serde_json::Error),
    #[error("internal lock poisoned")]
    Poisoned,
}

pub type Result<T> = std::result::Result<T, Error>;
