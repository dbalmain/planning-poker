use crate::error::{Error, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Deck {
    pub id: &'static str,
    pub label: &'static str,
    pub cards: &'static [&'static str],
}

pub const FIBONACCI: Deck = Deck {
    id: "fibonacci",
    label: "Fibonacci",
    cards: &["0", "½", "1", "2", "3", "5", "8", "13", "21", "?", "☕"],
};

pub const MODIFIED_FIBONACCI: Deck = Deck {
    id: "modified_fibonacci",
    label: "Modified Fibonacci",
    cards: &["0", "½", "1", "2", "3", "5", "8", "13", "20", "?", "☕"],
};

pub const POWERS_OF_TWO: Deck = Deck {
    id: "powers_of_two",
    label: "Powers of 2",
    cards: &["0", "1", "2", "4", "8", "16", "32", "?", "☕"],
};

pub const TSHIRT: Deck = Deck {
    id: "tshirt",
    label: "T-shirt",
    cards: &["XS", "S", "M", "L", "XL", "XXL", "?", "☕"],
};

pub const ALL: &[Deck] = &[FIBONACCI, MODIFIED_FIBONACCI, POWERS_OF_TWO, TSHIRT];

impl Deck {
    pub fn parse(id: &str) -> Result<Deck> {
        ALL.iter()
            .copied()
            .find(|deck| deck.id == id)
            .ok_or(Error::UnknownDeck)
    }

    pub fn contains(self, card: &str) -> bool {
        self.cards.contains(&card)
    }

    pub fn preview(self) -> String {
        let values = self.cards.join(", ");
        format!("{} ({values})", self.label)
    }
}

/// `?` and coffee are signals, not estimates — everyone sees them immediately.
pub fn is_open(card: &str) -> bool {
    card == "?" || card == "☕"
}

pub fn parse_numeric(card: &str) -> Option<f64> {
    if card == "½" {
        return Some(0.5);
    }
    card.parse().ok()
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn every_deck_has_question_and_coffee() {
        for deck in ALL {
            assert!(deck.contains("?"), "{}", deck.id);
            assert!(deck.contains("☕"), "{}", deck.id);
        }
    }

    #[test]
    fn parse_rejects_unknown() {
        assert!(Deck::parse("scrabble").is_err());
        assert_eq!(Deck::parse("fibonacci").unwrap().id, "fibonacci");
    }

    #[test]
    fn fibonacci_includes_half() {
        assert!(FIBONACCI.contains("½"));
    }

    #[test]
    fn fibonacci_stops_at_twenty_one() {
        assert!(FIBONACCI.contains("21"));
        assert!(!FIBONACCI.contains("34"));
        assert!(!FIBONACCI.contains("55"));
        assert!(!FIBONACCI.contains("89"));
    }

    #[test]
    fn modified_fibonacci_stops_at_twenty() {
        assert!(MODIFIED_FIBONACCI.contains("20"));
        assert!(!MODIFIED_FIBONACCI.contains("40"));
        assert!(!MODIFIED_FIBONACCI.contains("100"));
    }

    #[test]
    fn powers_of_two_stops_at_thirty_two() {
        assert!(POWERS_OF_TWO.contains("32"));
        assert!(!POWERS_OF_TWO.contains("64"));
    }

    #[test]
    fn half_is_numeric() {
        assert_eq!(parse_numeric("½"), Some(0.5));
        assert_eq!(parse_numeric("8"), Some(8.0));
        assert_eq!(parse_numeric("?"), None);
        assert_eq!(parse_numeric("☕"), None);
        assert_eq!(parse_numeric("M"), None);
    }
}
