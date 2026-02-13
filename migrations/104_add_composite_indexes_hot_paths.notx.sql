-- Migration 095: Add composite indexes for hot query paths
-- Uses CONCURRENTLY to avoid locking tables during creation (requires .notx. filename)
--
-- Note: idx_matchups_league_week and idx_waiver_claims_roster already exist
-- from earlier migrations (020, 024). They are included here with IF NOT EXISTS
-- for completeness and documentation of the performance-critical index set.

-- 1. Drafts: used by slow-auction job polling every 5 seconds
--    Query filters on status + draft_type + pick_deadline (slow-auction.job.ts:186-197)
--    Existing idx_drafts_status only covers (status), forcing extra filtering on heap
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_drafts_status_type_deadline
  ON drafts(status, draft_type, pick_deadline);

-- 2. Waiver claims: used on dashboard load (dashboard.service.ts:195-197)
--    Query filters on roster_id + status for pending claim counts
--    Already exists from migration 024 as idx_waiver_claims_roster
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_waiver_claims_roster_status
  ON waiver_claims(roster_id, status);

-- 3. Matchups: used on matchups page, one of the most visited screens
--    Query filters on league_id + season + week (matchups.repository.ts:20-43)
--    Already exists from migration 020 as idx_matchups_league_week
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_matchups_league_season_week
  ON matchups(league_id, season, week);
