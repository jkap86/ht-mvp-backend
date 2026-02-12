-- Add matchups draft type support

-- 1. Add pick_metadata column to draft_picks to support matchup selections
ALTER TABLE draft_picks
ADD COLUMN IF NOT EXISTS pick_metadata JSONB DEFAULT NULL;

-- 2. Add index on pick_metadata for efficient queries
CREATE INDEX IF NOT EXISTS idx_draft_picks_metadata ON draft_picks USING GIN (pick_metadata);

-- 3. Add generated_from_draft_id to matchups table to link back to draft
ALTER TABLE matchups
ADD COLUMN IF NOT EXISTS generated_from_draft_id INTEGER REFERENCES drafts(id) ON DELETE SET NULL;

-- 4. Add index for matchups lookup by draft
CREATE INDEX IF NOT EXISTS idx_matchups_generated_from_draft ON matchups(generated_from_draft_id)
WHERE generated_from_draft_id IS NOT NULL;

-- 5. Relax player_id NOT NULL constraint for matchup draft picks
-- (matchup picks won't have a player_id, only pick_metadata)
ALTER TABLE draft_picks
ALTER COLUMN player_id DROP NOT NULL;

-- 6. Add constraint to ensure either player_id OR pick_metadata is present
ALTER TABLE draft_picks
ADD CONSTRAINT draft_picks_player_or_metadata CHECK (
    (player_id IS NOT NULL AND pick_metadata IS NULL) OR
    (player_id IS NULL AND pick_metadata IS NOT NULL)
);

-- Note: draft_type field already supports arbitrary VARCHAR(20), so 'matchups' fits
-- No enum type to alter - just need to update application code to handle 'matchups' type
