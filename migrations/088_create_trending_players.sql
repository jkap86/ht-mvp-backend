-- Migration: Create trending players tracking
-- Stream E: Waiver Wire Enhancements (E1.1)

-- Trending players table for waiver wire recommendations
CREATE TABLE IF NOT EXISTS trending_players (
    id SERIAL PRIMARY KEY,
    player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,

    -- Activity metrics
    adds_last_24h INTEGER DEFAULT 0,
    drops_last_24h INTEGER DEFAULT 0,
    adds_last_week INTEGER DEFAULT 0,
    drops_last_week INTEGER DEFAULT 0,

    -- Ownership metrics
    total_rostered INTEGER DEFAULT 0, -- How many rosters own this player
    ownership_percentage DECIMAL(5,2) DEFAULT 0.00, -- Percentage across all active leagues

    -- Trending score (calculated from adds/drops velocity)
    trending_score DECIMAL(8,2) DEFAULT 0.00, -- Higher = hotter pickup
    trend_direction VARCHAR(10) DEFAULT 'neutral', -- 'up', 'down', 'neutral'

    -- Performance context
    recent_points_avg DECIMAL(6,2), -- Average points last 3 games
    projected_points_next DECIMAL(6,2), -- Next week projection

    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    UNIQUE(player_id)
);

-- Indexes for sorting and filtering
CREATE INDEX idx_trending_players_score ON trending_players(trending_score DESC);
CREATE INDEX idx_trending_players_ownership ON trending_players(ownership_percentage DESC);
CREATE INDEX idx_trending_players_direction ON trending_players(trend_direction);
CREATE INDEX idx_trending_players_updated ON trending_players(updated_at DESC);

-- Composite index for "hot pickups" query (trending up + high score)
CREATE INDEX idx_trending_hot_pickups ON trending_players(trend_direction, trending_score DESC)
WHERE trend_direction = 'up';

-- Add comments
COMMENT ON TABLE trending_players IS 'Tracks player add/drop trends for waiver wire recommendations';
COMMENT ON COLUMN trending_players.trending_score IS 'Calculated score based on add velocity, recent performance, and ownership change';
COMMENT ON COLUMN trending_players.trend_direction IS 'Direction of trend: up (heating up), down (cooling off), neutral (stable)';
