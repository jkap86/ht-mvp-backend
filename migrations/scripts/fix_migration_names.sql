-- Fix migration names in the migrations table after renumbering duplicates.
-- Run this BEFORE running the migration runner against the new filenames.
-- Safe to run multiple times (uses WHERE EXISTS checks).

BEGIN;

-- 084: backfill_league_season_ids kept its number (no change needed)
-- 084 → 085: create_player_news
UPDATE migrations SET name = '085_create_player_news.sql'
  WHERE name = '084_create_player_news.sql';

-- 085 → 086: add_draft_constraints
UPDATE migrations SET name = '086_add_draft_constraints.sql'
  WHERE name = '085_add_draft_constraints.sql';

-- 085 → 087: add_player_headshots
UPDATE migrations SET name = '087_add_player_headshots.sql'
  WHERE name = '085_add_player_headshots.sql';

-- 086 → 088: add_processing_run_status
UPDATE migrations SET name = '088_add_processing_run_status.sql'
  WHERE name = '086_add_processing_run_status.sql';

-- 087 → 089: add_trades_idempotency
UPDATE migrations SET name = '089_add_trades_idempotency.sql'
  WHERE name = '087_add_trades_idempotency.sql';

-- 087 → 090: create_notification_preferences
UPDATE migrations SET name = '090_create_notification_preferences.sql'
  WHERE name = '087_create_notification_preferences.sql';

-- 088 → 091: add_active_league_season
UPDATE migrations SET name = '091_add_active_league_season.sql'
  WHERE name = '088_add_active_league_season.sql';

-- 088 → 092: create_trending_players
UPDATE migrations SET name = '092_create_trending_players.sql'
  WHERE name = '088_create_trending_players.sql';

-- 089 → 093: create_player_external_ids
UPDATE migrations SET name = '093_create_player_external_ids.sql'
  WHERE name = '089_create_player_external_ids.sql';

-- 089 → 094: fix_league_operations_type
UPDATE migrations SET name = '094_fix_league_operations_type.sql'
  WHERE name = '089_fix_league_operations_type.sql';

-- 090 → 095: backfill_sleeper_external_ids
UPDATE migrations SET name = '095_backfill_sleeper_external_ids.sql'
  WHERE name = '090_backfill_sleeper_external_ids.sql';

-- 090 → 096: fix_waiver_partial_index
UPDATE migrations SET name = '096_fix_waiver_partial_index.sql'
  WHERE name = '090_fix_waiver_partial_index.sql';

-- 091 → 097: add_stats_provider_to_league_seasons
UPDATE migrations SET name = '097_add_stats_provider_to_league_seasons.sql'
  WHERE name = '091_add_stats_provider_to_league_seasons.sql';

-- 091 → 098: create_player_rankings
UPDATE migrations SET name = '098_create_player_rankings.sql'
  WHERE name = '091_create_player_rankings.sql';

-- 092 → 099: add_performance_indexes
UPDATE migrations SET name = '099_add_performance_indexes.sql'
  WHERE name = '092_add_performance_indexes.sql';

-- 093 → 100: add_draft_completion_guards
UPDATE migrations SET name = '100_add_draft_completion_guards.sql'
  WHERE name = '093_add_draft_completion_guards.sql';

-- 093 → 101: create_reaction_tables
UPDATE migrations SET name = '101_create_reaction_tables.sql'
  WHERE name = '093_create_reaction_tables.sql';

-- 094 → 102: add_league_timezone
UPDATE migrations SET name = '102_add_league_timezone.sql'
  WHERE name = '094_add_league_timezone.sql';

-- 094 → 103: drop_canonical_roster_order_check
UPDATE migrations SET name = '103_drop_canonical_roster_order_check.sql'
  WHERE name = '094_drop_canonical_roster_order_check.sql';

-- 095 → 104: add_composite_indexes_hot_paths
UPDATE migrations SET name = '104_add_composite_indexes_hot_paths.notx.sql'
  WHERE name = '095_add_composite_indexes_hot_paths.notx.sql';

-- 096 → 105: add_roster_population_status
UPDATE migrations SET name = '105_add_roster_population_status.sql'
  WHERE name = '096_add_roster_population_status.sql';

-- 097 → 106: add_trade_failed_status
UPDATE migrations SET name = '106_add_trade_failed_status.sql'
  WHERE name = '097_add_trade_failed_status.sql';

-- 098 → 107: add_users_updated_at_trigger
UPDATE migrations SET name = '107_add_users_updated_at_trigger.sql'
  WHERE name = '098_add_users_updated_at_trigger.sql';

-- 099 → 108: add_missing_fk_indexes
UPDATE migrations SET name = '108_add_missing_fk_indexes.sql'
  WHERE name = '099_add_missing_fk_indexes.sql';

-- 100 → 109: add_overnight_pause_to_drafts
UPDATE migrations SET name = '109_add_overnight_pause_to_drafts.sql'
  WHERE name = '100_add_overnight_pause_to_drafts.sql';

-- 101 → 110: add_chat_search_indexes_simple
-- Handle both possible old names (simple or concurrent version)
UPDATE migrations SET name = '110_add_chat_search_indexes_simple.sql'
  WHERE name = '101_add_chat_search_indexes_simple.sql';
UPDATE migrations SET name = '110_add_chat_search_indexes_simple.sql'
  WHERE name = '101_add_chat_search_indexes.sql';

-- 102 → 111: add_matchups_draft_support
UPDATE migrations SET name = '111_add_matchups_draft_support.sql'
  WHERE name = '102_add_matchups_draft_support.sql';

-- 103 → 112: fix_auction_roster_cascade
UPDATE migrations SET name = '112_fix_auction_roster_cascade.sql'
  WHERE name = '103_fix_auction_roster_cascade.sql';

-- 104 → 113: remove_redundant_username_index
UPDATE migrations SET name = '113_remove_redundant_username_index.sql'
  WHERE name = '104_remove_redundant_username_index.sql';

-- Verify: show final state
SELECT id, name FROM migrations WHERE name ~ '^(08[4-9]|09|1[0-1])' ORDER BY name;

COMMIT;
