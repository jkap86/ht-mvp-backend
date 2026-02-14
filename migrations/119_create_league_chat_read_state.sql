-- League chat read state for unread count tracking
CREATE TABLE IF NOT EXISTS league_chat_read_state (
  league_id INTEGER NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_message_id INTEGER REFERENCES league_chat_messages(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (league_id, user_id)
);

-- Index for efficient per-user unread count queries
CREATE INDEX IF NOT EXISTS idx_league_chat_read_state_user_id
  ON league_chat_read_state (user_id);
