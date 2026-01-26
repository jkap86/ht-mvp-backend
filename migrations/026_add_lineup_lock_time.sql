-- Add lineup_lock_time column to leagues table
-- This controls when lineups are automatically locked for each week
-- Values: 'thursday_2020' (default - lock at Thursday 8:20 PM ET), 'individual_game', 'manual'
ALTER TABLE leagues ADD COLUMN IF NOT EXISTS lineup_lock_time VARCHAR(20) DEFAULT 'thursday_2020';

-- Index for efficient querying by lock time
CREATE INDEX IF NOT EXISTS idx_leagues_lineup_lock_time ON leagues(lineup_lock_time);
