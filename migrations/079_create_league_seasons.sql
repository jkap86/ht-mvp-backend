-- Migration 079: Create league_seasons table
-- Purpose: Support multi-season dynasty leagues with historical data preservation

-- League seasons table - represents each competitive year of a league
CREATE TABLE IF NOT EXISTS league_seasons (
    id SERIAL PRIMARY KEY,

    -- Parent league (franchise)
    league_id INTEGER NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,

    -- Season identifier (year)
    season INTEGER NOT NULL,

    -- Season-specific status
    status VARCHAR(20) DEFAULT 'pre_draft' CHECK (status IN ('pre_draft', 'drafting', 'in_season', 'playoffs', 'completed')),
    season_status VARCHAR(20) DEFAULT 'pre_season' CHECK (season_status IN ('pre_season', 'regular_season', 'playoffs', 'offseason')),
    current_week INTEGER DEFAULT 1,

    -- Season-specific settings (can override league defaults)
    season_settings JSONB DEFAULT '{}',

    -- Timestamps
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,

    -- Each league can have one season per year
    UNIQUE(league_id, season)
);

-- Indexes for performance
CREATE INDEX idx_league_seasons_league ON league_seasons(league_id);
CREATE INDEX idx_league_seasons_season ON league_seasons(season);
CREATE INDEX idx_league_seasons_status ON league_seasons(status);
CREATE INDEX idx_league_seasons_league_status ON league_seasons(league_id, status);

-- Index for "active season" queries
CREATE INDEX idx_league_seasons_active ON league_seasons(league_id, season DESC)
    WHERE status IN ('pre_draft', 'drafting', 'in_season', 'playoffs');

-- Trigger to update updated_at timestamp
CREATE TRIGGER update_league_seasons_updated_at
    BEFORE UPDATE ON league_seasons
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Comments
COMMENT ON TABLE league_seasons IS 'Represents each competitive year of a league. League becomes the perpetual franchise.';
COMMENT ON COLUMN league_seasons.league_id IS 'Reference to the parent league (franchise)';
COMMENT ON COLUMN league_seasons.season IS 'The year/season identifier (e.g., 2024, 2025)';
COMMENT ON COLUMN league_seasons.status IS 'Draft/competition status for this season';
COMMENT ON COLUMN league_seasons.season_status IS 'Phase of the season (pre_season, regular_season, playoffs, offseason)';
COMMENT ON COLUMN league_seasons.season_settings IS 'Season-specific overrides for league settings (JSONB)';
COMMENT ON COLUMN league_seasons.started_at IS 'Timestamp when season officially started (first draft began)';
COMMENT ON COLUMN league_seasons.completed_at IS 'Timestamp when season was marked as completed';
