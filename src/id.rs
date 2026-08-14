use rand::Rng;

const HEX: &[u8; 16] = b"0123456789abcdef";

/// 128-bit unguessable id, lowercase hex (32 characters).
pub fn random_id() -> String {
    let mut bytes = [0u8; 16];
    rand::rng().fill_bytes(&mut bytes);
    to_hex(&bytes)
}

pub fn is_player_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|b| b.is_ascii_hexdigit())
}

fn to_hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        out.push(HEX[usize::from(b >> 4)] as char);
        out.push(HEX[usize::from(b & 0x0f)] as char);
    }
    out
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn ids_are_32_hex_chars() {
        let id = random_id();
        assert_eq!(id.len(), 32);
        assert!(is_player_id(&id));
    }

    #[test]
    fn ids_are_unique_across_a_batch() {
        let ids: HashSet<String> = (0..256).map(|_| random_id()).collect();
        assert_eq!(ids.len(), 256);
    }

    #[test]
    fn rejects_short_or_non_hex_ids() {
        assert!(!is_player_id("abc"));
        assert!(!is_player_id(&"g".repeat(32)));
        assert!(!is_player_id(&"a".repeat(31)));
    }
}
