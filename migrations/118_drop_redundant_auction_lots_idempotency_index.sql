-- Remove overly restrictive auction_lots idempotency index from migration 076.
-- The idx_auction_lots_idempotency index from migration 072 (draft_id, nominator_roster_id, idempotency_key)
-- correctly matches the domain model and query patterns.
-- The 076 index (draft_id, idempotency_key) is redundant and overly restrictive.
DROP INDEX IF EXISTS auction_lots_unique_idempotency;

-- Remove duplicate auction_bid_history idempotency index from migration 076.
-- The idx_auction_bid_history_idempotency index from migration 072 already covers
-- the same columns (lot_id, roster_id, idempotency_key).
DROP INDEX IF EXISTS auction_bid_history_unique_idempotency;
