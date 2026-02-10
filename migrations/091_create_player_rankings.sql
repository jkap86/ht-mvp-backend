/**
 * Player Rankings Table
 * Phase 2 - Stream F: Player Rankings & Comparison
 *
 * Stores player rankings from multiple sources (consensus, ADP, dynasty, redraft)
 * Supports tiered rankings and position-specific ranks
 *
 * Architecture Note: Uses player_id (internal database primary key) ONLY.
 * NO sleeper_id dependencies - system is API-agnostic.
 */

-- Player Rankings Table
CREATE TABLE IF NOT EXISTS player_rankings (
    id SERIAL PRIMARY KEY,
    player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    ranking_source VARCHAR(50) NOT NULL, -- 'consensus', 'adp', 'dynasty', 'redraft'
    position VARCHAR(10), -- 'QB', 'RB', 'WR', 'TE', 'FLEX', 'OVERALL'
    rank INTEGER NOT NULL,
    tier INTEGER, -- Tiered rankings (1-10)
    value DECIMAL(6,2), -- Trade value or ADP round.pick
    season INTEGER NOT NULL,
    week INTEGER, -- NULL for season-long rankings
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(player_id, ranking_source, position, season, week)
);

-- Indexes for efficient ranking queries
CREATE INDEX idx_rankings_position_rank ON player_rankings(position, rank, ranking_source) WHERE position IS NOT NULL;
CREATE INDEX idx_rankings_tier ON player_rankings(tier, position) WHERE tier IS NOT NULL;
CREATE INDEX idx_rankings_player ON player_rankings(player_id, ranking_source);
CREATE INDEX idx_rankings_source_season ON player_rankings(ranking_source, season, week);

-- Comments
COMMENT ON TABLE player_rankings IS 'Player rankings from multiple sources for comparison and decision support';
COMMENT ON COLUMN player_rankings.ranking_source IS 'Source of ranking: consensus, adp (average draft position), dynasty, redraft';
COMMENT ON COLUMN player_rankings.position IS 'Position filter: QB, RB, WR, TE, FLEX, OVERALL. NULL for overall rankings.';
COMMENT ON COLUMN player_rankings.tier IS 'Tiered ranking group (1-10). Lower tier = better players.';
COMMENT ON COLUMN player_rankings.value IS 'Trade value points or ADP round.pick (e.g., 3.05 = 3rd round, 5th pick)';
COMMENT ON COLUMN player_rankings.week IS 'Week number for weekly rankings. NULL for season-long rankings.';
