-- Playoff bracket configuration for each league
CREATE TABLE IF NOT EXISTS playoff_brackets (
    id SERIAL PRIMARY KEY,
    league_id INTEGER NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
    season INTEGER NOT NULL,
    playoff_teams INTEGER NOT NULL DEFAULT 6,  -- 4, 6, or 8
    total_rounds INTEGER NOT NULL,
    championship_week INTEGER NOT NULL,
    start_week INTEGER NOT NULL,
    status VARCHAR(20) DEFAULT 'pending',  -- pending, active, completed
    champion_roster_id INTEGER REFERENCES rosters(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(league_id, season)
);

-- Playoff seeds
CREATE TABLE IF NOT EXISTS playoff_seeds (
    id SERIAL PRIMARY KEY,
    bracket_id INTEGER NOT NULL REFERENCES playoff_brackets(id) ON DELETE CASCADE,
    roster_id INTEGER NOT NULL REFERENCES rosters(id) ON DELETE CASCADE,
    seed INTEGER NOT NULL,
    regular_season_record VARCHAR(20),
    points_for DECIMAL(8,2),
    has_bye BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(bracket_id, seed),
    UNIQUE(bracket_id, roster_id)
);

-- Extend matchups table for playoff metadata
ALTER TABLE matchups ADD COLUMN IF NOT EXISTS playoff_round INTEGER;
ALTER TABLE matchups ADD COLUMN IF NOT EXISTS playoff_seed1 INTEGER;
ALTER TABLE matchups ADD COLUMN IF NOT EXISTS playoff_seed2 INTEGER;
ALTER TABLE matchups ADD COLUMN IF NOT EXISTS bracket_position INTEGER;

-- Indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_playoff_brackets_league ON playoff_brackets(league_id, season);
CREATE INDEX IF NOT EXISTS idx_playoff_seeds_bracket ON playoff_seeds(bracket_id);
CREATE INDEX IF NOT EXISTS idx_matchups_playoff ON matchups(league_id, season, is_playoff) WHERE is_playoff = true;
