-- Drafts table
CREATE TABLE IF NOT EXISTS drafts (
    id SERIAL PRIMARY KEY,
    league_id INTEGER NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
    draft_type VARCHAR(20) NOT NULL DEFAULT 'snake',
    status VARCHAR(20) NOT NULL DEFAULT 'not_started',
    current_pick INTEGER DEFAULT 1,
    current_round INTEGER DEFAULT 1,
    current_roster_id INTEGER,
    pick_time_seconds INTEGER DEFAULT 90,
    pick_deadline TIMESTAMPTZ,
    rounds INTEGER NOT NULL DEFAULT 15,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    settings JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_drafts_league_id ON drafts(league_id);
CREATE INDEX IF NOT EXISTS idx_drafts_status ON drafts(status);

-- Trigger for updated_at
DROP TRIGGER IF EXISTS update_drafts_updated_at ON drafts;
CREATE TRIGGER update_drafts_updated_at
    BEFORE UPDATE ON drafts
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
