use std::path::Path;
use std::sync::{Arc, Mutex};

use rusqlite::{Connection, OptionalExtension, params};

use crate::deck::Deck;
use crate::error::{Error, Result};
use crate::game::{Board, CompletedRound, Phase, Player, VoteRecord};

#[derive(Clone)]
pub struct Db {
    conn: Arc<Mutex<Connection>>,
}

#[derive(Debug, Clone)]
struct LiveRow {
    ticket: String,
    phase: String,
    proposed_estimate: Option<String>,
    votes_json: String,
}

impl Db {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent()
            && !parent.as_os_str().is_empty()
        {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS boards (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                deck TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS live_state (
                board_id TEXT PRIMARY KEY REFERENCES boards(id) ON DELETE CASCADE,
                ticket TEXT NOT NULL,
                phase TEXT NOT NULL,
                proposed_estimate TEXT,
                votes_json TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS players (
                board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
                player_id TEXT NOT NULL,
                name TEXT NOT NULL,
                spectator INTEGER NOT NULL,
                PRIMARY KEY (board_id, player_id)
            );
            CREATE TABLE IF NOT EXISTS rounds (
                id TEXT PRIMARY KEY,
                board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
                ticket TEXT NOT NULL,
                agreed TEXT NOT NULL,
                votes_json TEXT NOT NULL,
                completed_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS rounds_board_idx
                ON rounds (board_id, completed_at);
            ",
        )?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    pub async fn create_board(&self, id: &str, name: &str, deck: &str) -> Result<()> {
        let id = id.to_owned();
        let name = name.to_owned();
        let deck = deck.to_owned();
        self.blocking(move |conn| {
            conn.execute(
                "INSERT INTO boards (id, name, deck, created_at) VALUES (?1, ?2, ?3, ?4)",
                params![id, name, deck, chrono::Utc::now().to_rfc3339()],
            )?;
            conn.execute(
                "INSERT INTO live_state (board_id, ticket, phase, proposed_estimate, votes_json)
                 VALUES (?1, '', 'voting', NULL, '{}')",
                params![id],
            )?;
            Ok(())
        })
        .await
    }

    pub async fn board_meta(&self, id: &str) -> Result<Option<(String, String, String)>> {
        let id = id.to_owned();
        self.blocking(move |conn| {
            conn.query_row(
                "SELECT id, name, deck FROM boards WHERE id = ?1",
                params![id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .optional()
            .map_err(Error::from)
        })
        .await
    }

    pub async fn load_board(&self, id: &str) -> Result<Option<Board>> {
        let id = id.to_owned();
        self.blocking(move |conn| load_board(conn, &id)).await
    }

    pub async fn save_live(&self, board: &Board) -> Result<()> {
        let board = board.clone();
        self.blocking(move |conn| save_live(conn, &board)).await
    }

    pub async fn list_rounds(&self, board_id: &str) -> Result<Vec<CompletedRound>> {
        let board_id = board_id.to_owned();
        self.blocking(move |conn| load_rounds(conn, &board_id))
            .await
    }

    pub async fn insert_round(&self, board_id: &str, round: &CompletedRound) -> Result<()> {
        let board_id = board_id.to_owned();
        let round = round.clone();
        self.blocking(move |conn| {
            let votes = serde_json::to_string(&round.votes)?;
            conn.execute(
                "INSERT INTO rounds (id, board_id, ticket, agreed, votes_json, completed_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    round.id,
                    board_id,
                    round.ticket,
                    round.agreed,
                    votes,
                    round.completed_at
                ],
            )?;
            Ok(())
        })
        .await
    }

    async fn blocking<T, F>(&self, f: F) -> Result<T>
    where
        T: Send + 'static,
        F: FnOnce(&Connection) -> Result<T> + Send + 'static,
    {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || {
            let guard = conn.lock().map_err(|_| Error::Poisoned)?;
            f(&guard)
        })
        .await
        .map_err(|_| Error::DbTask)?
    }
}

fn load_board(conn: &Connection, id: &str) -> Result<Option<Board>> {
    let Some((id, name, deck_id)) = conn
        .query_row(
            "SELECT id, name, deck FROM boards WHERE id = ?1",
            params![id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .optional()?
    else {
        return Ok(None);
    };

    let deck = Deck::parse(&deck_id)?;
    let mut board = Board::new(id.clone(), name, deck)?;

    if let Some(live) = conn
        .query_row(
            "SELECT ticket, phase, proposed_estimate, votes_json
             FROM live_state WHERE board_id = ?1",
            params![id],
            |row| {
                Ok(LiveRow {
                    ticket: row.get(0)?,
                    phase: row.get(1)?,
                    proposed_estimate: row.get(2)?,
                    votes_json: row.get(3)?,
                })
            },
        )
        .optional()?
    {
        board.ticket = live.ticket;
        board.phase = match live.phase.as_str() {
            "revealed" => Phase::Revealed,
            "choosing" => Phase::Choosing,
            _ => Phase::Voting,
        };
        board.proposed_estimate = live.proposed_estimate;
        board.votes = serde_json::from_str(&live.votes_json)?;
    }

    let mut stmt =
        conn.prepare("SELECT player_id, name, spectator FROM players WHERE board_id = ?1")?;
    let players = stmt.query_map(params![id], |row| {
        Ok(Player {
            id: row.get(0)?,
            name: row.get(1)?,
            spectator: row.get::<_, i64>(2)? != 0,
            connected: false,
        })
    })?;
    for player in players {
        let player = player?;
        board.players.insert(player.id.clone(), player);
    }

    board.completed = load_rounds(conn, &id)?;

    Ok(Some(board))
}

fn load_rounds(conn: &Connection, board_id: &str) -> Result<Vec<CompletedRound>> {
    let mut stmt = conn.prepare(
        "SELECT id, ticket, agreed, votes_json, completed_at
         FROM rounds WHERE board_id = ?1 ORDER BY completed_at ASC",
    )?;
    let rounds = stmt.query_map(params![board_id], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, String>(4)?,
        ))
    })?;
    let mut out = Vec::new();
    for round in rounds {
        let (round_id, ticket, agreed, votes_json, completed_at) = round?;
        let votes: Vec<VoteRecord> = serde_json::from_str(&votes_json)?;
        out.push(CompletedRound {
            id: round_id,
            ticket,
            agreed,
            votes,
            completed_at,
        });
    }
    Ok(out)
}

fn save_live(conn: &Connection, board: &Board) -> Result<()> {
    let votes = serde_json::to_string(&board.votes)?;
    let phase = match board.phase {
        Phase::Voting => "voting",
        Phase::Revealed => "revealed",
        Phase::Choosing => "choosing",
    };
    conn.execute(
        "UPDATE boards SET deck = ?2 WHERE id = ?1",
        params![board.id, board.deck.id],
    )?;
    conn.execute(
        "UPDATE live_state
         SET ticket = ?2, phase = ?3, proposed_estimate = ?4, votes_json = ?5
         WHERE board_id = ?1",
        params![
            board.id,
            board.ticket,
            phase,
            board.proposed_estimate,
            votes
        ],
    )?;

    conn.execute("DELETE FROM players WHERE board_id = ?1", params![board.id])?;
    for player in board.players.values() {
        conn.execute(
            "INSERT INTO players (board_id, player_id, name, spectator)
             VALUES (?1, ?2, ?3, ?4)",
            params![board.id, player.id, player.name, player.spectator as i64],
        )?;
    }
    Ok(())
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use crate::id;
    use std::collections::BTreeMap;

    fn temp_db() -> (Db, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::open(&dir.path().join("t.db")).unwrap();
        (db, dir)
    }

    #[tokio::test]
    async fn create_and_load_round_trip() {
        let (db, _dir) = temp_db();
        let board_id = id::random_id();
        db.create_board(&board_id, "Sprint", "fibonacci")
            .await
            .unwrap();

        let mut board = db.load_board(&board_id).await.unwrap().unwrap();
        let dave = id::random_id();
        board.join(&dave, "Dave", false).unwrap();
        board.set_ticket("PROJ-1").unwrap();
        board.vote(&dave, "8").unwrap();
        db.save_live(&board).await.unwrap();

        let loaded = db.load_board(&board_id).await.unwrap().unwrap();
        assert_eq!(loaded.ticket, "PROJ-1");
        assert_eq!(loaded.votes.get(&dave).map(String::as_str), Some("8"));
        assert_eq!(loaded.players[&dave].name, "Dave");
        assert!(!loaded.players[&dave].connected);
    }

    #[tokio::test]
    async fn persist_completed_round() {
        let (db, _dir) = temp_db();
        let board_id = id::random_id();
        db.create_board(&board_id, "Sprint", "fibonacci")
            .await
            .unwrap();
        let mut board = db.load_board(&board_id).await.unwrap().unwrap();
        let dave = id::random_id();
        board.join(&dave, "Dave", false).unwrap();
        board.set_ticket("PROJ-2").unwrap();
        board.vote(&dave, "5").unwrap();
        board.reveal().unwrap();
        board.pick_estimate(&dave).unwrap();
        board.set_estimate(&dave, "5").unwrap();
        let round = board.confirm_round(&dave).unwrap();
        db.insert_round(&board_id, &round).await.unwrap();
        db.save_live(&board).await.unwrap();

        let loaded = db.load_board(&board_id).await.unwrap().unwrap();
        assert_eq!(loaded.completed.len(), 1);
        assert_eq!(loaded.completed[0].ticket, "PROJ-2");
        assert_eq!(loaded.completed[0].agreed, "5");
        assert_eq!(loaded.completed[0].votes[0].name, "Dave");
        assert_eq!(loaded.phase, Phase::Voting);

        let listed = db.list_rounds(&board_id).await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].ticket, "PROJ-2");
    }

    #[tokio::test]
    async fn changing_deck_persists() {
        let (db, _dir) = temp_db();
        let board_id = id::random_id();
        db.create_board(&board_id, "Sprint", "fibonacci")
            .await
            .unwrap();
        let mut board = db.load_board(&board_id).await.unwrap().unwrap();
        let dave = id::random_id();
        board.join(&dave, "Dave", false).unwrap();
        board.set_deck(&dave, crate::deck::TSHIRT).unwrap();
        db.save_live(&board).await.unwrap();
        let loaded = db.load_board(&board_id).await.unwrap().unwrap();
        assert_eq!(loaded.deck.id, "tshirt");
        let meta = db.board_meta(&board_id).await.unwrap().unwrap();
        assert_eq!(meta.2, "tshirt");
    }

    #[tokio::test]
    async fn missing_board_is_none() {
        let (db, _dir) = temp_db();
        assert!(db.load_board("nope").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn votes_map_round_trips() {
        let votes: BTreeMap<String, String> =
            BTreeMap::from([("aa".into(), "5".into()), ("bb".into(), "?".into())]);
        let json = serde_json::to_string(&votes).unwrap();
        let back: BTreeMap<String, String> = serde_json::from_str(&json).unwrap();
        assert_eq!(votes, back);
    }
}
