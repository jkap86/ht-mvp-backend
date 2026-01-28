-- Link draft_picks to draft_pick_assets
-- Allows tracking which asset a completed pick was made with

ALTER TABLE draft_picks
    ADD COLUMN IF NOT EXISTS draft_pick_asset_id INTEGER REFERENCES draft_pick_assets(id);

-- Index for asset lookups
CREATE INDEX IF NOT EXISTS idx_draft_picks_asset ON draft_picks(draft_pick_asset_id) WHERE draft_pick_asset_id IS NOT NULL;

COMMENT ON COLUMN draft_picks.draft_pick_asset_id IS 'Reference to the draft_pick_asset that was used for this pick';
