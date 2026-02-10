-- Migration 092: Add performance indexes for hot-path queries
-- These indexes optimize frequently-used query patterns

-- 1. Auction bid history: optimize lookups by lot + recency
-- Existing idx_auction_bid_history_lot_id only covers (lot_id)
-- This adds created_at DESC for efficient "latest bids" queries
CREATE INDEX IF NOT EXISTS idx_auction_bids_lot_created
  ON auction_bid_history(lot_id, created_at DESC);

-- 2. Roster players: covering index for ownership checks
-- findOwner() joins roster_players → rosters and needs player_id
-- INCLUDE avoids a heap lookup for the common case
CREATE INDEX IF NOT EXISTS idx_roster_players_roster_player
  ON roster_players(roster_id, player_id);

-- 3. Waiver wire: composite for season-scoped league lookups
-- getByLeague() filters by league_id + optional league_season_id
CREATE INDEX IF NOT EXISTS idx_waiver_wire_league_player
  ON waiver_wire(league_id, player_id);

-- 4. Trades: composite for pending-player lookups (findPendingByPlayer)
-- Joins trade_items and filters by league_id + status
CREATE INDEX IF NOT EXISTS idx_trades_league_pending
  ON trades(league_id, status)
  WHERE status IN ('pending', 'accepted', 'in_review');

-- 5. Roster transactions: composite for league-scoped history queries
-- getByLeague() orders by created_at DESC with limit/offset
CREATE INDEX IF NOT EXISTS idx_roster_transactions_league_created
  ON roster_transactions(league_id, created_at DESC);
