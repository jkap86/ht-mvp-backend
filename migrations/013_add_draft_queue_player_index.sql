-- Migration: Add index on draft_queue player_id for faster lookups
-- This improves performance when removing drafted players from all queues

CREATE INDEX IF NOT EXISTS idx_draft_queue_player ON draft_queue(player_id);
