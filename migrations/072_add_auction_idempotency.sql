-- Add idempotency key support to auction tables.
-- Follows the same pattern as draft_picks idempotency (migration 016).

-- Nomination idempotency
ALTER TABLE auction_lots ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(255);
CREATE UNIQUE INDEX IF NOT EXISTS idx_auction_lots_idempotency
    ON auction_lots (draft_id, nominator_roster_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;

-- Bid history idempotency
ALTER TABLE auction_bid_history ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(255);
CREATE UNIQUE INDEX IF NOT EXISTS idx_auction_bid_history_idempotency
    ON auction_bid_history (lot_id, roster_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;
