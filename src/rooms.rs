use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tokio::sync::{Mutex as AsyncMutex, broadcast};

use crate::db::Db;
use crate::error::{Error, Result};
use crate::game::{Board, Snapshot};
use crate::protocol::ClientMsg;

pub struct Room {
    board: AsyncMutex<Board>,
    pub notify: broadcast::Sender<()>,
}

#[derive(Clone)]
pub struct Rooms {
    db: Db,
    live: Arc<Mutex<HashMap<String, Arc<Room>>>>,
}

impl Rooms {
    pub fn new(db: Db) -> Self {
        Self {
            db,
            live: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn get(&self, board_id: &str) -> Result<Arc<Room>> {
        if let Some(room) = self.cached(board_id)? {
            return Ok(room);
        }
        let board = self
            .db
            .load_board(board_id)
            .await?
            .ok_or(Error::BoardNotFound)?;
        self.insert(board)
    }

    pub async fn apply(&self, room: &Room, player_id: &str, msg: ClientMsg) -> Result<Snapshot> {
        let mut board = room.board.lock().await;
        match msg {
            ClientMsg::Join { .. } => {}
            ClientMsg::SetTicket { ticket } => board.set_ticket(&ticket)?,
            ClientMsg::Vote { card } => board.vote(player_id, &card)?,
            ClientMsg::Reveal => board.reveal()?,
            ClientMsg::PickEstimate => board.pick_estimate(player_id)?,
            ClientMsg::SetEstimate { card } => board.set_estimate(player_id, &card)?,
            ClientMsg::ConfirmRound => {
                let round = board.confirm_round(player_id)?;
                self.db.insert_round(&board.id, &round).await?;
            }
            ClientMsg::Revote => board.revote(player_id)?,
            ClientMsg::SetSpectator { spectator } => {
                board.set_spectator(player_id, spectator)?;
            }
            ClientMsg::SetDeck { deck } => {
                board.set_deck(player_id, crate::deck::Deck::parse(&deck)?)?;
            }
        }
        let snapshot = board.snapshot(player_id)?;
        self.db.save_live(&board).await?;
        let _ = room.notify.send(());
        Ok(snapshot)
    }

    pub async fn join(
        &self,
        room: &Room,
        player_id: &str,
        name: &str,
        spectator: bool,
    ) -> Result<Snapshot> {
        let mut board = room.board.lock().await;
        board.join(player_id, name, spectator)?;
        let snapshot = board.snapshot(player_id)?;
        self.db.save_live(&board).await?;
        let _ = room.notify.send(());
        Ok(snapshot)
    }

    pub async fn disconnect(&self, room: &Room, player_id: &str) -> Result<()> {
        let mut board = room.board.lock().await;
        board.disconnect(player_id);
        self.db.save_live(&board).await?;
        let _ = room.notify.send(());
        Ok(())
    }

    fn cached(&self, board_id: &str) -> Result<Option<Arc<Room>>> {
        let live = self.live.lock().map_err(|_| Error::Poisoned)?;
        Ok(live.get(board_id).cloned())
    }

    fn insert(&self, board: Board) -> Result<Arc<Room>> {
        let mut live = self.live.lock().map_err(|_| Error::Poisoned)?;
        if let Some(existing) = live.get(&board.id) {
            return Ok(existing.clone());
        }
        let (notify, _) = broadcast::channel(16);
        let id = board.id.clone();
        let room = Arc::new(Room {
            board: AsyncMutex::new(board),
            notify,
        });
        live.insert(id, room.clone());
        Ok(room)
    }
}

impl Room {
    pub async fn snapshot(&self, player_id: &str) -> Result<Snapshot> {
        self.board.lock().await.snapshot(player_id)
    }

    pub fn subscribe(&self) -> broadcast::Receiver<()> {
        self.notify.subscribe()
    }
}
