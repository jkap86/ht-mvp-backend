-- Leagues table
CREATE TABLE IF NOT EXISTS leagues (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    status VARCHAR(20) DEFAULT 'pre_draft',
    settings JSONB DEFAULT '{}',
    scoring_settings JSONB DEFAULT '{}',
    season VARCHAR(4) NOT NULL,
    total_rosters INTEGER DEFAULT 12,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_leagues_season ON leagues(season);
CREATE INDEX IF NOT EXISTS idx_leagues_status ON leagues(status);

-- Trigger for updated_at
DROP TRIGGER IF EXISTS update_leagues_updated_at ON leagues;
CREATE TRIGGER update_leagues_updated_at
    BEFORE UPDATE ON leagues
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
