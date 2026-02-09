-- Add DESC index for efficient league chat pagination
-- This index optimizes the common query pattern: ORDER BY id DESC with league_id filter

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_league_chat_id_desc
ON league_chat_messages (league_id, id DESC);
