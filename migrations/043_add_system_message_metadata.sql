-- Add metadata column for rich message data (trade details, player names, etc.)
ALTER TABLE league_chat_messages ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT NULL;

-- Index for message type queries
CREATE INDEX IF NOT EXISTS idx_league_chat_message_type
ON league_chat_messages(message_type);
