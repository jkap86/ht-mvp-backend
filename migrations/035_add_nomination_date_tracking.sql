-- Add nomination_date column for daily nomination limit tracking
ALTER TABLE auction_lots ADD COLUMN IF NOT EXISTS nomination_date DATE;

-- Index for efficient daily nomination queries
CREATE INDEX IF NOT EXISTS idx_auction_lots_daily
  ON auction_lots(draft_id, nominator_roster_id, nomination_date);

-- Backfill existing lots with their creation date
UPDATE auction_lots
SET nomination_date = DATE(created_at)
WHERE nomination_date IS NULL;
