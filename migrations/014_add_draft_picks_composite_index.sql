-- Migration: Add composite index on draft_picks for common query patterns
-- This improves performance when fetching picks with roster and player info

CREATE INDEX IF NOT EXISTS idx_draft_picks_draft_roster_player
ON draft_picks(draft_id, roster_id, player_id);
