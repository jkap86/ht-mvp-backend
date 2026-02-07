-- Add league median scoring feature
-- When enabled, teams earn an additional W/L/T each week based on comparison to the league median score

-- Create table to store weekly median results
-- Each row represents one roster's result against the median for a given week
CREATE TABLE IF NOT EXISTS weekly_median_results (
    id SERIAL PRIMARY KEY,
    league_id INTEGER NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
    season INTEGER NOT NULL,
    week INTEGER NOT NULL,
    median_points DECIMAL(6,2) NOT NULL,
    roster_id INTEGER NOT NULL REFERENCES rosters(id) ON DELETE CASCADE,
    roster_points DECIMAL(6,2) NOT NULL,
    -- 'W' = above median, 'L' = below median, 'T' = exactly median
    result CHAR(1) NOT NULL CHECK (result IN ('W', 'L', 'T')),
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,

    -- Each roster can only have one median result per week
    UNIQUE(league_id, season, week, roster_id)
);

-- Index for efficient standings queries (aggregate by league/season)
CREATE INDEX IF NOT EXISTS idx_weekly_median_league_week
    ON weekly_median_results(league_id, season, week);

-- Index for roster-specific queries
CREATE INDEX IF NOT EXISTS idx_weekly_median_roster
    ON weekly_median_results(roster_id, season);
