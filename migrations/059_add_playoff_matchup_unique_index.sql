-- Prevent duplicate playoff matchups (same round/position)
-- Protects against double-generate, double-advance, race conditions
CREATE UNIQUE INDEX IF NOT EXISTS idx_playoff_matchups_unique
ON matchups (league_id, season, playoff_round, bracket_position)
WHERE is_playoff = true;
