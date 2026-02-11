-- Migration: Drop the canonical_roster_order CHECK constraint
-- The CHECK (roster1_id < roster2_id) prevented home/away alternation in schedule generation.
-- The LEAST/GREATEST unique index (migration 054) already prevents duplicate matchups
-- regardless of roster ordering, so this CHECK constraint is redundant for dedup.
-- Dropping it allows the schedule generator to alternate home/away assignments
-- based on round parity for fairness.

ALTER TABLE matchups
DROP CONSTRAINT canonical_roster_order;
