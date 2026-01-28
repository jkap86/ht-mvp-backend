-- Draft pick assets table
-- Tracks ownership of draft pick slots as tradeable assets
-- Decouples "who is scheduled to pick" from "who owns the pick"

CREATE TABLE IF NOT EXISTS draft_pick_assets (
    id SERIAL PRIMARY KEY,

    -- Which league this pick belongs to
    league_id INTEGER NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,

    -- Which draft (NULL for future season picks that don't have a draft yet)
    draft_id INTEGER REFERENCES drafts(id) ON DELETE CASCADE,

    -- The pick slot identifier
    season INTEGER NOT NULL,
    round INTEGER NOT NULL,

    -- Original assignment (never changes - used to identify the pick)
    original_roster_id INTEGER NOT NULL REFERENCES rosters(id) ON DELETE CASCADE,

    -- Current ownership (changes when pick is traded)
    current_owner_roster_id INTEGER NOT NULL REFERENCES rosters(id) ON DELETE CASCADE,

    -- Position within the round (set when draft order is confirmed)
    -- E.g., if original_roster_id has draft position 3, this would be 3
    original_pick_position INTEGER,

    -- Timestamps
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,

    -- Each pick slot is unique: league + season + round + original owner
    UNIQUE(league_id, season, round, original_roster_id)
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_draft_pick_assets_league_season ON draft_pick_assets(league_id, season);
CREATE INDEX IF NOT EXISTS idx_draft_pick_assets_draft ON draft_pick_assets(draft_id) WHERE draft_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_draft_pick_assets_owner ON draft_pick_assets(current_owner_roster_id);
CREATE INDEX IF NOT EXISTS idx_draft_pick_assets_original ON draft_pick_assets(original_roster_id);

-- Trigger for updated_at
CREATE TRIGGER update_draft_pick_assets_updated_at
    BEFORE UPDATE ON draft_pick_assets
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

COMMENT ON TABLE draft_pick_assets IS 'Tradeable draft pick ownership. original_roster_id identifies the pick slot; current_owner_roster_id is who owns it now.';
COMMENT ON COLUMN draft_pick_assets.draft_id IS 'NULL for future season picks where the draft has not been created yet.';
COMMENT ON COLUMN draft_pick_assets.original_pick_position IS 'The pick number within the round based on original owner draft position. NULL until draft order is confirmed.';
