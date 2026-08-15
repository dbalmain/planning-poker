CREATE TABLE IF NOT EXISTS boards (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  deck TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rounds (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  ticket TEXT NOT NULL,
  agreed TEXT NOT NULL,
  votes_json TEXT NOT NULL,
  completed_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS rounds_board_idx ON rounds (board_id, completed_at);
CREATE INDEX IF NOT EXISTS boards_last_used_idx ON boards (last_used_at);
