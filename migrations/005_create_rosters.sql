-- Rosters table (connects users to leagues)
CREATE TABLE IF NOT EXISTS rosters (
    id SERIAL PRIMARY KEY,
    league_id INTEGER NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    roster_id INTEGER NOT NULL,
    settings JSONB DEFAULT '{}',
    starters JSONB DEFAULT '[]',
    bench JSONB DEFAULT '[]',
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT unique_league_user UNIQUE(league_id, user_id),
    CONSTRAINT unique_league_roster UNIQUE(league_id, roster_id)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_rosters_league_id ON rosters(league_id);
CREATE INDEX IF NOT EXISTS idx_rosters_user_id ON rosters(user_id);

-- Trigger for updated_at
DROP TRIGGER IF EXISTS update_rosters_updated_at ON rosters;
CREATE TRIGGER update_rosters_updated_at
    BEFORE UPDATE ON rosters
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
