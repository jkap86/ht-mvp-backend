-- Migration: Create vet_draft_pick_selections table
-- Purpose: Track draft pick assets (future rookie draft picks) selected during vet-only drafts

CREATE TABLE IF NOT EXISTS vet_draft_pick_selections (
    id SERIAL PRIMARY KEY,
    draft_id INTEGER NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
    draft_pick_asset_id INTEGER NOT NULL REFERENCES draft_pick_assets(id),
    pick_number INTEGER NOT NULL,
    roster_id INTEGER NOT NULL REFERENCES rosters(id),
    selected_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    -- Ensure each pick asset can only be drafted once per vet draft
    UNIQUE(draft_id, draft_pick_asset_id),
    -- Ensure each pick number in a draft is unique
    UNIQUE(draft_id, pick_number)
);

-- Index for querying by draft
CREATE INDEX IF NOT EXISTS idx_vet_draft_pick_selections_draft_id
    ON vet_draft_pick_selections(draft_id);

-- Index for querying by roster (to find what pick assets a team has drafted)
CREATE INDEX IF NOT EXISTS idx_vet_draft_pick_selections_roster_id
    ON vet_draft_pick_selections(roster_id);

COMMENT ON TABLE vet_draft_pick_selections IS 'Tracks rookie draft pick assets selected during veteran-only drafts';
COMMENT ON COLUMN vet_draft_pick_selections.draft_id IS 'The vet draft where this pick asset was selected';
COMMENT ON COLUMN vet_draft_pick_selections.draft_pick_asset_id IS 'The future rookie draft pick asset that was selected';
COMMENT ON COLUMN vet_draft_pick_selections.pick_number IS 'The pick number in the vet draft when this asset was selected';
COMMENT ON COLUMN vet_draft_pick_selections.roster_id IS 'The roster that selected this pick asset';
