use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::deck::{self, Deck};
use crate::error::{Error, Result};
use crate::id;

pub const MAX_NAME_LEN: usize = 40;
pub const MAX_TICKET_LEN: usize = 80;
pub const MAX_BOARD_NAME_LEN: usize = 80;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    Voting,
    Revealed,
    Choosing,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Player {
    pub id: String,
    pub name: String,
    pub spectator: bool,
    pub connected: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VoteRecord {
    pub name: String,
    pub card: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CompletedRound {
    pub id: String,
    pub ticket: String,
    pub agreed: String,
    pub votes: Vec<VoteRecord>,
    pub completed_at: String,
}

#[derive(Debug, Clone)]
pub struct Board {
    pub id: String,
    pub name: String,
    pub deck: Deck,
    pub ticket: String,
    pub phase: Phase,
    pub players: BTreeMap<String, Player>,
    pub votes: BTreeMap<String, String>,
    pub proposed_estimate: Option<String>,
    pub completed: Vec<CompletedRound>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PlayerView {
    pub id: String,
    pub name: String,
    pub spectator: bool,
    pub connected: bool,
    pub has_voted: bool,
    pub vote: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Snapshot {
    pub board_id: String,
    pub board_name: String,
    pub deck_id: String,
    pub cards: Vec<String>,
    pub ticket: String,
    pub phase: Phase,
    pub proposed_estimate: Option<String>,
    pub players: Vec<PlayerView>,
    pub you: PlayerView,
    pub completed: Vec<CompletedRound>,
    pub average: Option<f64>,
}

impl Board {
    pub fn new(id: String, name: String, deck: Deck) -> Result<Self> {
        let name = normalize_board_name(&name)?;
        Ok(Self {
            id,
            name,
            deck,
            ticket: String::new(),
            phase: Phase::Voting,
            players: BTreeMap::new(),
            votes: BTreeMap::new(),
            proposed_estimate: None,
            completed: Vec::new(),
        })
    }

    pub fn join(&mut self, player_id: &str, name: &str, spectator: bool) -> Result<()> {
        if !id::is_player_id(player_id) {
            return Err(Error::InvalidPlayerId);
        }
        let name = normalize_name(name)?;
        if let Some(existing) = self.players.get_mut(player_id) {
            existing.name = name;
            existing.connected = true;
            if existing.spectator != spectator {
                self.set_spectator(player_id, spectator)?;
            }
            return Ok(());
        }
        self.players.insert(
            player_id.to_owned(),
            Player {
                id: player_id.to_owned(),
                name,
                spectator,
                connected: true,
            },
        );
        Ok(())
    }

    pub fn disconnect(&mut self, player_id: &str) {
        if let Some(player) = self.players.get_mut(player_id) {
            player.connected = false;
        }
    }

    pub fn set_ticket(&mut self, ticket: &str) -> Result<()> {
        let ticket = ticket.trim();
        if ticket.len() > MAX_TICKET_LEN {
            return Err(Error::TicketTooLong);
        }
        self.ticket = ticket.to_owned();
        Ok(())
    }

    pub fn set_deck(&mut self, player_id: &str, deck: Deck) -> Result<()> {
        self.require_player(player_id)?;
        self.deck = deck;
        self.votes.retain(|_, card| deck.contains(card));
        if self
            .proposed_estimate
            .as_deref()
            .is_some_and(|card| !deck.contains(card))
        {
            self.proposed_estimate = None;
        }
        Ok(())
    }

    pub fn vote(&mut self, player_id: &str, card: &str) -> Result<()> {
        let player = self.players.get(player_id).ok_or(Error::NotJoined)?;
        if player.spectator {
            return Err(Error::Spectator);
        }
        match self.phase {
            Phase::Voting | Phase::Revealed => {}
            Phase::Choosing => return Err(Error::VotesLocked),
        }
        if !self.deck.contains(card) {
            return Err(Error::UnknownCard);
        }
        self.votes.insert(player_id.to_owned(), card.to_owned());
        Ok(())
    }

    pub fn reveal(&mut self) -> Result<()> {
        if self.phase != Phase::Voting {
            return Err(Error::AlreadyRevealed);
        }
        self.phase = Phase::Revealed;
        Ok(())
    }

    pub fn pick_estimate(&mut self, player_id: &str) -> Result<()> {
        self.require_player(player_id)?;
        match self.phase {
            Phase::Revealed => {
                self.phase = Phase::Choosing;
                Ok(())
            }
            Phase::Choosing => Ok(()),
            Phase::Voting => Err(Error::NotRevealed),
        }
    }

    pub fn set_estimate(&mut self, player_id: &str, card: &str) -> Result<()> {
        self.require_player(player_id)?;
        if self.phase != Phase::Choosing {
            return Err(Error::NotChoosing);
        }
        if !self.deck.contains(card) {
            return Err(Error::UnknownCard);
        }
        self.proposed_estimate = Some(card.to_owned());
        Ok(())
    }

    pub fn confirm_round(&mut self, player_id: &str) -> Result<CompletedRound> {
        self.require_player(player_id)?;
        if self.phase != Phase::Choosing {
            return Err(if self.phase == Phase::Revealed {
                Error::NotChoosing
            } else {
                Error::NotRevealed
            });
        }
        let ticket = self.ticket.trim();
        if ticket.is_empty() {
            return Err(Error::NoTicket);
        }
        let agreed = self.proposed_estimate.clone().ok_or(Error::NoEstimate)?;
        let votes = self.voter_records();
        let round = CompletedRound {
            id: id::random_id(),
            ticket: ticket.to_owned(),
            agreed,
            votes,
            completed_at: chrono::Utc::now().to_rfc3339(),
        };
        self.completed.push(round.clone());
        self.reset_round();
        self.prune_disconnected();
        Ok(round)
    }

    pub fn revote(&mut self, player_id: &str) -> Result<()> {
        self.require_player(player_id)?;
        if !self.face_up() {
            return Err(Error::NotRevealed);
        }
        self.votes.retain(|_, card| card == "☕");
        self.proposed_estimate = None;
        self.phase = Phase::Voting;
        self.prune_disconnected();
        Ok(())
    }

    pub fn set_spectator(&mut self, player_id: &str, spectator: bool) -> Result<()> {
        let player = self.players.get_mut(player_id).ok_or(Error::NotJoined)?;
        player.spectator = spectator;
        if spectator {
            self.votes.remove(player_id);
        }
        Ok(())
    }

    pub fn snapshot(&self, viewer_id: &str) -> Result<Snapshot> {
        let you = self.players.get(viewer_id).ok_or(Error::NotJoined)?;
        let players = self
            .players
            .values()
            .map(|player| self.player_view(player, viewer_id))
            .collect();
        Ok(Snapshot {
            board_id: self.id.clone(),
            board_name: self.name.clone(),
            deck_id: self.deck.id.to_owned(),
            cards: self
                .deck
                .cards
                .iter()
                .map(|card| (*card).to_owned())
                .collect(),
            ticket: self.ticket.clone(),
            phase: self.phase,
            proposed_estimate: self.proposed_estimate.clone(),
            players,
            you: self.player_view(you, viewer_id),
            completed: self.completed.clone(),
            average: self.average(),
        })
    }

    fn player_view(&self, player: &Player, viewer_id: &str) -> PlayerView {
        let vote = self.votes.get(&player.id);
        let show_vote = self.face_up()
            || player.id == viewer_id
            || vote.is_some_and(|card| deck::is_open(card));
        PlayerView {
            id: player.id.clone(),
            name: player.name.clone(),
            spectator: player.spectator,
            connected: player.connected,
            has_voted: vote.is_some(),
            vote: if show_vote { vote.cloned() } else { None },
        }
    }

    fn average(&self) -> Option<f64> {
        if !self.face_up() {
            return None;
        }
        let nums: Vec<f64> = self
            .votes
            .values()
            .filter_map(|card| deck::parse_numeric(card))
            .collect();
        if nums.is_empty() {
            return None;
        }
        Some(nums.iter().sum::<f64>() / nums.len() as f64)
    }

    fn voter_records(&self) -> Vec<VoteRecord> {
        self.players
            .values()
            .filter(|player| !player.spectator)
            .map(|player| VoteRecord {
                name: player.name.clone(),
                card: self.votes.get(&player.id).cloned(),
            })
            .collect()
    }

    fn reset_round(&mut self) {
        self.ticket.clear();
        self.votes.clear();
        self.proposed_estimate = None;
        self.phase = Phase::Voting;
    }

    fn prune_disconnected(&mut self) {
        let gone: Vec<String> = self
            .players
            .values()
            .filter(|player| !player.connected)
            .map(|player| player.id.clone())
            .collect();
        for id in gone {
            self.players.remove(&id);
            self.votes.remove(&id);
        }
    }

    fn require_player(&self, player_id: &str) -> Result<()> {
        if self.players.contains_key(player_id) {
            Ok(())
        } else {
            Err(Error::NotJoined)
        }
    }

    fn face_up(&self) -> bool {
        matches!(self.phase, Phase::Revealed | Phase::Choosing)
    }
}

pub fn normalize_name(name: &str) -> Result<String> {
    let name = name.trim();
    if name.is_empty() {
        return Err(Error::EmptyName);
    }
    if name.len() > MAX_NAME_LEN {
        return Err(Error::NameTooLong);
    }
    Ok(name.to_owned())
}

pub fn normalize_board_name(name: &str) -> Result<String> {
    let name = name.trim();
    if name.len() > MAX_BOARD_NAME_LEN {
        return Err(Error::BoardNameTooLong);
    }
    if name.is_empty() {
        Ok("Planning session".to_owned())
    } else {
        Ok(name.to_owned())
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use crate::deck::FIBONACCI;

    fn board() -> Board {
        Board::new("b".into(), "Sprint".into(), FIBONACCI).unwrap()
    }

    fn pid(n: u8) -> String {
        format!("{n:032x}")
    }

    fn seated() -> (Board, String, String) {
        let mut board = board();
        let dave = pid(1);
        let sam = pid(2);
        board.join(&dave, "Dave", false).unwrap();
        board.join(&sam, "Sam", false).unwrap();
        (board, dave, sam)
    }

    #[test]
    fn empty_session_name_defaults() {
        let board = Board::new("b".into(), "  ".into(), FIBONACCI).unwrap();
        assert_eq!(board.name, "Planning session");
    }

    #[test]
    fn votes_stay_hidden_until_reveal() {
        let (mut board, dave, sam) = seated();
        board.vote(&dave, "5").unwrap();
        board.vote(&sam, "8").unwrap();

        let dave_view = board.snapshot(&dave).unwrap();
        let sam_from_dave = dave_view.players.iter().find(|p| p.id == sam).unwrap();
        assert!(sam_from_dave.has_voted);
        assert_eq!(sam_from_dave.vote, None);
        assert_eq!(dave_view.you.vote.as_deref(), Some("5"));
        assert_eq!(dave_view.average, None);

        board.reveal().unwrap();
        let dave_view = board.snapshot(&dave).unwrap();
        let sam_from_dave = dave_view.players.iter().find(|p| p.id == sam).unwrap();
        assert_eq!(sam_from_dave.vote.as_deref(), Some("8"));
        assert_eq!(dave_view.average, Some(6.5));
    }

    #[test]
    fn can_change_vote_before_reveal() {
        let (mut board, dave, _) = seated();
        board.vote(&dave, "3").unwrap();
        board.vote(&dave, "13").unwrap();
        assert_eq!(board.votes.get(&dave).map(String::as_str), Some("13"));
    }

    #[test]
    fn can_change_vote_after_reveal() {
        let (mut board, dave, _) = seated();
        board.vote(&dave, "5").unwrap();
        board.reveal().unwrap();
        board.vote(&dave, "8").unwrap();
        assert_eq!(board.votes.get(&dave).map(String::as_str), Some("8"));
        let view = board.snapshot(&dave).unwrap();
        assert_eq!(view.you.vote.as_deref(), Some("8"));
        assert_eq!(view.average, Some(8.0));
    }

    #[test]
    fn cannot_vote_while_choosing() {
        let (mut board, dave, _) = seated();
        board.vote(&dave, "5").unwrap();
        board.reveal().unwrap();
        board.pick_estimate(&dave).unwrap();
        assert!(matches!(board.vote(&dave, "8"), Err(Error::VotesLocked)));
    }

    #[test]
    fn spectator_cannot_vote_and_is_excluded_from_records() {
        let (mut board, dave, sam) = seated();
        board.set_spectator(&sam, true).unwrap();
        assert!(matches!(board.vote(&sam, "5"), Err(Error::Spectator)));
        board.vote(&dave, "5").unwrap();
        board.set_ticket("PROJ-1").unwrap();
        board.reveal().unwrap();
        board.pick_estimate(&dave).unwrap();
        board.set_estimate(&dave, "5").unwrap();
        let round = board.confirm_round(&dave).unwrap();
        assert_eq!(round.votes.len(), 1);
        assert_eq!(round.votes[0].name, "Dave");
        assert_eq!(round.votes[0].card.as_deref(), Some("5"));
    }

    #[test]
    fn becoming_spectator_clears_a_vote() {
        let (mut board, dave, _) = seated();
        board.vote(&dave, "8").unwrap();
        board.set_spectator(&dave, true).unwrap();
        assert!(!board.votes.contains_key(&dave));
    }

    #[test]
    fn confirm_requires_ticket_and_estimate() {
        let (mut board, dave, _) = seated();
        board.vote(&dave, "5").unwrap();
        board.reveal().unwrap();
        assert!(matches!(
            board.confirm_round(&dave),
            Err(Error::NotChoosing)
        ));
        board.pick_estimate(&dave).unwrap();
        assert!(matches!(board.confirm_round(&dave), Err(Error::NoTicket)));
        board.set_ticket("PROJ-9").unwrap();
        assert!(matches!(board.confirm_round(&dave), Err(Error::NoEstimate)));
        board.set_estimate(&dave, "5").unwrap();
        let round = board.confirm_round(&dave).unwrap();
        assert_eq!(round.ticket, "PROJ-9");
        assert_eq!(round.agreed, "5");
        assert_eq!(board.phase, Phase::Voting);
        assert!(board.ticket.is_empty());
        assert!(board.votes.is_empty());
        assert_eq!(board.completed.len(), 1);
    }

    #[test]
    fn confirm_records_non_voters() {
        let (mut board, dave, _sam) = seated();
        board.vote(&dave, "3").unwrap();
        board.set_ticket("T-1").unwrap();
        board.reveal().unwrap();
        board.pick_estimate(&dave).unwrap();
        board.set_estimate(&dave, "3").unwrap();
        let round = board.confirm_round(&dave).unwrap();
        let sam_vote = round.votes.iter().find(|v| v.name == "Sam").unwrap();
        assert_eq!(sam_vote.card, None);
    }

    #[test]
    fn revote_hides_cards_again() {
        let (mut board, dave, _) = seated();
        board.vote(&dave, "2").unwrap();
        board.reveal().unwrap();
        board.revote(&dave).unwrap();
        assert_eq!(board.phase, Phase::Voting);
        assert!(board.votes.is_empty());
        assert!(board.proposed_estimate.is_none());
    }

    #[test]
    fn revote_keeps_coffee() {
        let (mut board, dave, sam) = seated();
        board.vote(&dave, "☕").unwrap();
        board.vote(&sam, "8").unwrap();
        board.reveal().unwrap();
        board.revote(&dave).unwrap();
        assert_eq!(board.phase, Phase::Voting);
        assert_eq!(board.votes.get(&dave).map(String::as_str), Some("☕"));
        assert!(!board.votes.contains_key(&sam));
    }

    #[test]
    fn unknown_card_is_rejected() {
        let (mut board, dave, _) = seated();
        assert!(matches!(board.vote(&dave, "99"), Err(Error::UnknownCard)));
    }

    #[test]
    fn rejoin_reclaims_the_same_seat() {
        let (mut board, dave, _) = seated();
        board.vote(&dave, "5").unwrap();
        board.disconnect(&dave);
        board.join(&dave, "David", false).unwrap();
        assert_eq!(board.players[&dave].name, "David");
        assert!(board.players[&dave].connected);
        assert_eq!(board.votes.get(&dave).map(String::as_str), Some("5"));
    }

    #[test]
    fn confirm_drops_disconnected_players() {
        let (mut board, dave, sam) = seated();
        board.vote(&dave, "5").unwrap();
        board.disconnect(&sam);
        board.set_ticket("X").unwrap();
        board.reveal().unwrap();
        board.pick_estimate(&dave).unwrap();
        board.set_estimate(&dave, "5").unwrap();
        board.confirm_round(&dave).unwrap();
        assert!(!board.players.contains_key(&sam));
        assert!(board.players.contains_key(&dave));
    }

    #[test]
    fn question_and_coffee_are_visible_before_reveal() {
        let (mut board, dave, sam) = seated();
        board.vote(&dave, "?").unwrap();
        board.vote(&sam, "☕").unwrap();
        let dave_view = board.snapshot(&dave).unwrap();
        let sam_from_dave = dave_view.players.iter().find(|p| p.id == sam).unwrap();
        assert_eq!(sam_from_dave.vote.as_deref(), Some("☕"));
        assert_eq!(dave_view.you.vote.as_deref(), Some("?"));
    }

    #[test]
    fn numeric_votes_stay_hidden_when_a_signal_is_showing() {
        let (mut board, dave, sam) = seated();
        board.vote(&dave, "?").unwrap();
        board.vote(&sam, "8").unwrap();
        let dave_view = board.snapshot(&dave).unwrap();
        let sam_from_dave = dave_view.players.iter().find(|p| p.id == sam).unwrap();
        assert!(sam_from_dave.has_voted);
        assert_eq!(sam_from_dave.vote, None);
    }

    #[test]
    fn set_deck_drops_cards_that_are_not_in_the_new_deck() {
        let (mut board, dave, sam) = seated();
        board.vote(&dave, "8").unwrap();
        board.vote(&sam, "13").unwrap();
        board.set_deck(&dave, crate::deck::POWERS_OF_TWO).unwrap();
        assert_eq!(board.deck.id, "powers_of_two");
        assert_eq!(board.votes.get(&dave).map(String::as_str), Some("8"));
        assert!(!board.votes.contains_key(&sam));
    }

    #[test]
    fn fibonacci_accepts_a_half() {
        let (mut board, dave, _) = seated();
        board.vote(&dave, "½").unwrap();
        assert_eq!(board.votes.get(&dave).map(String::as_str), Some("½"));
    }

    #[test]
    fn anyone_at_the_table_can_reveal() {
        let (mut board, dave, sam) = seated();
        board.vote(&dave, "1").unwrap();
        board.reveal().unwrap();
        assert_eq!(board.phase, Phase::Revealed);
        board.revote(&sam).unwrap();
        assert_eq!(board.phase, Phase::Voting);
    }

    #[test]
    fn pick_estimate_locks_votes_and_unlocks_save() {
        let (mut board, dave, sam) = seated();
        board.vote(&dave, "5").unwrap();
        board.vote(&sam, "8").unwrap();
        board.set_ticket("T-2").unwrap();
        board.reveal().unwrap();
        board.vote(&sam, "5").unwrap();
        assert_eq!(board.average(), Some(5.0));
        board.pick_estimate(&dave).unwrap();
        assert_eq!(board.phase, Phase::Choosing);
        board.set_estimate(&sam, "5").unwrap();
        assert_eq!(board.proposed_estimate.as_deref(), Some("5"));
        let round = board.confirm_round(&dave).unwrap();
        assert_eq!(round.agreed, "5");
        assert_eq!(round.votes.len(), 2);
    }

    #[test]
    fn cannot_set_estimate_during_discussion() {
        let (mut board, dave, _) = seated();
        board.vote(&dave, "5").unwrap();
        board.reveal().unwrap();
        assert!(matches!(
            board.set_estimate(&dave, "5"),
            Err(Error::NotChoosing)
        ));
    }
}
