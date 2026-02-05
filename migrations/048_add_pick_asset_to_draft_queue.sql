-- Add pick asset support to draft queue
-- Allows users to queue draft pick assets alongside players

-- Make player_id nullable
ALTER TABLE draft_queue ALTER COLUMN player_id DROP NOT NULL;

-- Add pick_asset_id column
ALTER TABLE draft_queue ADD COLUMN pick_asset_id INTEGER REFERENCES draft_pick_assets(id) ON DELETE CASCADE;

-- Ensure exactly one is set (either player_id or pick_asset_id, but not both)
ALTER TABLE draft_queue ADD CONSTRAINT chk_queue_item_type
  CHECK ((player_id IS NOT NULL AND pick_asset_id IS NULL) OR (player_id IS NULL AND pick_asset_id IS NOT NULL));

-- Unique constraint for pick assets (similar to the existing player_id unique constraint)
CREATE UNIQUE INDEX idx_draft_queue_pick_asset_unique
  ON draft_queue(draft_id, roster_id, pick_asset_id) WHERE pick_asset_id IS NOT NULL;

-- Index for efficient lookups by pick_asset_id
CREATE INDEX idx_draft_queue_pick_asset ON draft_queue(pick_asset_id) WHERE pick_asset_id IS NOT NULL;
