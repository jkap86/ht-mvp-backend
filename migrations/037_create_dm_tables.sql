-- Direct Messages feature tables

-- Conversations table (1:1 between two users)
CREATE TABLE IF NOT EXISTS conversations (
    id SERIAL PRIMARY KEY,
    user1_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user2_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- Per-conversation read tracking (more efficient than per-message)
    user1_last_read_message_id INTEGER,
    user2_last_read_message_id INTEGER,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    -- Canonical ordering using text comparison for UUID consistency
    CONSTRAINT unique_conversation UNIQUE (user1_id, user2_id),
    CONSTRAINT canonical_order CHECK (user1_id::text < user2_id::text),
    CONSTRAINT different_users CHECK (user1_id != user2_id)
);

-- Direct messages table
CREATE TABLE IF NOT EXISTS direct_messages (
    id SERIAL PRIMARY KEY,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    sender_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    message TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Add foreign key constraints for last_read after direct_messages exists
ALTER TABLE conversations
    ADD CONSTRAINT fk_user1_last_read FOREIGN KEY (user1_last_read_message_id) REFERENCES direct_messages(id) ON DELETE SET NULL,
    ADD CONSTRAINT fk_user2_last_read FOREIGN KEY (user2_last_read_message_id) REFERENCES direct_messages(id) ON DELETE SET NULL;

-- Indexes for conversations
CREATE INDEX idx_conversations_user1 ON conversations(user1_id);
CREATE INDEX idx_conversations_user2 ON conversations(user2_id);

-- Indexes for direct_messages
CREATE INDEX idx_dm_conversation_created ON direct_messages(conversation_id, created_at DESC);
CREATE INDEX idx_dm_sender ON direct_messages(sender_id);

-- Trigger for updated_at on conversations
CREATE TRIGGER update_conversations_updated_at
    BEFORE UPDATE ON conversations
    FOR EACH ROW
    EXECUTE FUNCTION trigger_set_timestamp();
