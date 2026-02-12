-- Migration 099: Add missing foreign key indexes
--
-- PostgreSQL does NOT automatically create indexes on foreign key columns.
-- Multiple FK columns lack indexes, causing sequential scans during JOINs,
-- DELETE cascades, and lookups. This migration adds single-column indexes
-- on FK columns that don't already have one (either standalone or as the
-- leading column of an existing composite/partial index).
--
-- Uses IF NOT EXISTS for idempotency. Does NOT use CONCURRENTLY because the
-- migration runner wraps migrations in a transaction block.

-- =============================================================================
-- trade_items: from_roster_id and to_roster_id have no indexes at all
-- =============================================================================
CREATE INDEX IF NOT EXISTS idx_trade_items_from_roster
  ON trade_items(from_roster_id);

CREATE INDEX IF NOT EXISTS idx_trade_items_to_roster
  ON trade_items(to_roster_id);

-- =============================================================================
-- trade_votes: roster_id is only in a UNIQUE(trade_id, roster_id) constraint
-- where it is NOT the leading column, so lookups by roster_id alone seq scan
-- =============================================================================
CREATE INDEX IF NOT EXISTS idx_trade_votes_roster
  ON trade_votes(roster_id);

-- =============================================================================
-- trades: parent_trade_id (self-referencing FK for counter-offers) has no index
-- =============================================================================
CREATE INDEX IF NOT EXISTS idx_trades_parent
  ON trades(parent_trade_id)
  WHERE parent_trade_id IS NOT NULL;

-- =============================================================================
-- roster_transactions: player_id FK has no index
-- (roster_id is already a leading column in idx_roster_transactions_roster;
--  league_id is already a leading column in idx_roster_transactions_league_created)
-- =============================================================================
CREATE INDEX IF NOT EXISTS idx_roster_transactions_player
  ON roster_transactions(player_id);

-- =============================================================================
-- waiver_claims: player_id only has a PARTIAL index (WHERE status = 'pending').
-- A full index is needed for FK enforcement and non-pending lookups.
-- drop_player_id FK has no index at all.
-- =============================================================================
CREATE INDEX IF NOT EXISTS idx_waiver_claims_player_full
  ON waiver_claims(player_id);

CREATE INDEX IF NOT EXISTS idx_waiver_claims_drop_player
  ON waiver_claims(drop_player_id)
  WHERE drop_player_id IS NOT NULL;

-- =============================================================================
-- waiver_wire: dropped_by_roster_id FK has no index
-- =============================================================================
CREATE INDEX IF NOT EXISTS idx_waiver_wire_dropped_by_roster
  ON waiver_wire(dropped_by_roster_id)
  WHERE dropped_by_roster_id IS NOT NULL;

-- =============================================================================
-- auction_lots: several FK columns lack indexes
--   - player_id is only in a composite unique (draft_id, player_id) as non-leading
--   - nominator_roster_id has no index
--   - current_bidder_roster_id has no index
--   - winning_roster_id has no index
-- =============================================================================
CREATE INDEX IF NOT EXISTS idx_auction_lots_player
  ON auction_lots(player_id);

CREATE INDEX IF NOT EXISTS idx_auction_lots_nominator_roster
  ON auction_lots(nominator_roster_id);

CREATE INDEX IF NOT EXISTS idx_auction_lots_current_bidder
  ON auction_lots(current_bidder_roster_id)
  WHERE current_bidder_roster_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_auction_lots_winning_roster
  ON auction_lots(winning_roster_id)
  WHERE winning_roster_id IS NOT NULL;

-- =============================================================================
-- auction_proxy_bids: roster_id FK has no index
-- (lot_id is already indexed via idx_auction_proxy_bids_lot_id)
-- =============================================================================
CREATE INDEX IF NOT EXISTS idx_auction_proxy_bids_roster
  ON auction_proxy_bids(roster_id);

-- =============================================================================
-- auction_bid_history: roster_id FK has no index
-- (lot_id is already indexed via idx_auction_bid_history_lot_id)
-- =============================================================================
CREATE INDEX IF NOT EXISTS idx_auction_bid_history_roster
  ON auction_bid_history(roster_id);

-- =============================================================================
-- playoff_brackets: champion_roster_id FK has no index
-- =============================================================================
CREATE INDEX IF NOT EXISTS idx_playoff_brackets_champion
  ON playoff_brackets(champion_roster_id)
  WHERE champion_roster_id IS NOT NULL;

-- =============================================================================
-- playoff_seeds: roster_id FK has no index
-- (bracket_id is already indexed via idx_playoff_seeds_bracket)
-- =============================================================================
CREATE INDEX IF NOT EXISTS idx_playoff_seeds_roster
  ON playoff_seeds(roster_id);

-- =============================================================================
-- dues_payments: marked_by_user_id FK has no index
-- (roster_id already has idx_dues_payments_roster;
--  league_id already has idx_dues_payments_league)
-- =============================================================================
CREATE INDEX IF NOT EXISTS idx_dues_payments_marked_by
  ON dues_payments(marked_by_user_id)
  WHERE marked_by_user_id IS NOT NULL;
