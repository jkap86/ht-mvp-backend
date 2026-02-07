-- Migration: Add expression index for canonical pair uniqueness
-- Defense-in-depth: catches edge cases if CHECK constraint is bypassed via direct SQL
-- The CHECK constraint (roster1_id < roster2_id) prevents reversed pairs at insert time,
-- but this index provides additional protection for admin tools, imports, or manual SQL.

CREATE UNIQUE INDEX IF NOT EXISTS idx_matchups_canonical_pair
ON matchups (league_id, season, week, LEAST(roster1_id, roster2_id), GREATEST(roster1_id, roster2_id));
