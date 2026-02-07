-- Migration 056: Create player_projections table
-- Separates projections from actual stats to prevent overwrites during live games

CREATE TABLE IF NOT EXISTS player_projections (
    id SERIAL PRIMARY KEY,
    player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    season INTEGER NOT NULL,
    week INTEGER NOT NULL,
    -- Passing (using DECIMAL for fractional projections)
    pass_yards DECIMAL(6,2) DEFAULT 0,
    pass_td DECIMAL(4,2) DEFAULT 0,
    pass_int DECIMAL(4,2) DEFAULT 0,
    -- Rushing
    rush_yards DECIMAL(6,2) DEFAULT 0,
    rush_td DECIMAL(4,2) DEFAULT 0,
    -- Receiving
    receptions DECIMAL(5,2) DEFAULT 0,
    rec_yards DECIMAL(6,2) DEFAULT 0,
    rec_td DECIMAL(4,2) DEFAULT 0,
    -- Misc
    fumbles_lost DECIMAL(4,2) DEFAULT 0,
    two_pt_conversions DECIMAL(4,2) DEFAULT 0,
    -- Kicking
    fg_made DECIMAL(4,2) DEFAULT 0,
    fg_missed DECIMAL(4,2) DEFAULT 0,
    pat_made DECIMAL(4,2) DEFAULT 0,
    pat_missed DECIMAL(4,2) DEFAULT 0,
    -- Defense
    def_td DECIMAL(4,2) DEFAULT 0,
    def_int DECIMAL(4,2) DEFAULT 0,
    def_sacks DECIMAL(4,1) DEFAULT 0,
    def_fumble_rec DECIMAL(4,2) DEFAULT 0,
    def_safety DECIMAL(4,2) DEFAULT 0,
    def_points_allowed DECIMAL(5,2) DEFAULT 0,
    -- Timestamps
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(player_id, season, week)
);

-- Index for efficient lookups by player/season/week
CREATE INDEX IF NOT EXISTS idx_player_projections_lookup
ON player_projections(player_id, season, week);

-- Index for batch fetches by season/week (used during live scoring calculations)
CREATE INDEX IF NOT EXISTS idx_player_projections_season_week
ON player_projections(season, week);
