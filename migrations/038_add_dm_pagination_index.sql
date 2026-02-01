-- Add index for efficient message pagination by ID
-- Supports queries like: WHERE conversation_id = $1 AND id < $2 ORDER BY id DESC
-- This complements the existing idx_dm_conversation_created index

CREATE INDEX IF NOT EXISTS idx_dm_conversation_id_desc
ON direct_messages(conversation_id, id DESC);
