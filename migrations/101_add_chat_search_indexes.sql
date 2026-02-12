-- Add full-text search and timestamp indexes for chat navigation and search features

-- Full-text search index for league chat messages
-- Uses GIN index for fast full-text search on message content
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_league_chat_messages_fts
ON league_chat_messages USING GIN(to_tsvector('english', message));

-- Full-text search index for direct messages
-- Uses GIN index for fast full-text search on message content
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_dm_messages_fts
ON direct_messages USING GIN(to_tsvector('english', message));

-- Composite index for efficient timestamp-based queries on league chat
-- Supports queries like "get messages around timestamp" for date jump navigation
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_league_chat_messages_league_timestamp
ON league_chat_messages(league_id, created_at DESC, id DESC);

-- Composite index for efficient timestamp-based queries on DMs
-- Supports queries like "get messages around timestamp" for date jump navigation
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_dm_messages_conversation_timestamp
ON direct_messages(conversation_id, created_at DESC, id DESC);

-- Index to support filtering by message type (for hiding system messages in league chat)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_league_chat_messages_type
ON league_chat_messages(league_id, message_type, created_at DESC);
