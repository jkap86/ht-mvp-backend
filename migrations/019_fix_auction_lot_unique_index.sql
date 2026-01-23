-- Fix auction_lots unique constraint to allow re-nomination of passed players
-- The previous unique index on (draft_id, player_id) prevents re-nominating
-- a player after they pass with no bids.

-- Drop the old unconditional unique index
DROP INDEX IF EXISTS idx_auction_lots_draft_player;

-- Create a partial unique index that only enforces uniqueness for active/won lots
-- This allows a player to be re-nominated after their lot passes
CREATE UNIQUE INDEX IF NOT EXISTS idx_auction_lots_draft_player_active
    ON auction_lots(draft_id, player_id)
    WHERE status IN ('active', 'won');

-- Add a comment explaining the constraint
COMMENT ON INDEX idx_auction_lots_draft_player_active IS
    'Prevents duplicate active/won lots for same player in a draft, but allows re-nomination after pass';
