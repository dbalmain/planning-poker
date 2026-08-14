use serde::{Deserialize, Serialize};

use crate::game::Snapshot;

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientMsg {
    Join {
        player_id: String,
        name: String,
        spectator: bool,
    },
    SetTicket {
        ticket: String,
    },
    Vote {
        card: String,
    },
    Reveal,
    PickEstimate,
    SetEstimate {
        card: String,
    },
    ConfirmRound,
    Revote,
    SetSpectator {
        spectator: bool,
    },
    SetDeck {
        deck: String,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerMsg {
    Welcome { player_id: String, state: Snapshot },
    State { state: Snapshot },
    Error { message: String },
}

#[derive(Debug, Clone, Deserialize)]
pub struct CreateBoardRequest {
    pub name: Option<String>,
    pub deck: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BoardMeta {
    pub id: String,
    pub name: String,
    pub deck: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct DeckInfo {
    pub id: String,
    pub label: String,
    pub preview: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryResponse {
    pub id: String,
    pub name: String,
    pub rounds: Vec<crate::game::CompletedRound>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ErrorBody {
    pub error: String,
}
