-- League chat messages table
CREATE TABLE IF NOT EXISTS league_chat_messages (
    id SERIAL PRIMARY KEY,
    league_id INTEGER NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    message TEXT NOT NULL,
    message_type VARCHAR(20) DEFAULT 'chat',
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_league_chat_league_id ON league_chat_messages(league_id);
CREATE INDEX IF NOT EXISTS idx_league_chat_created_at ON league_chat_messages(league_id, created_at);
CREATE INDEX IF NOT EXISTS idx_league_chat_user_id ON league_chat_messages(user_id);
