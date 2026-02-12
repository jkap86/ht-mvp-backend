-- Fix missing ON DELETE CASCADE for auction table foreign keys to rosters
-- This allows proper cleanup when a league (and its rosters) is deleted

-- Drop and recreate the foreign key constraints with CASCADE behavior

-- 1. auction_lots.nominator_roster_id (required field - CASCADE delete)
ALTER TABLE auction_lots
DROP CONSTRAINT IF EXISTS auction_lots_nominator_roster_id_fkey;

ALTER TABLE auction_lots
ADD CONSTRAINT auction_lots_nominator_roster_id_fkey
FOREIGN KEY (nominator_roster_id) REFERENCES rosters(id) ON DELETE CASCADE;

-- 2. auction_lots.current_bidder_roster_id (nullable - SET NULL on delete)
ALTER TABLE auction_lots
DROP CONSTRAINT IF EXISTS auction_lots_current_bidder_roster_id_fkey;

ALTER TABLE auction_lots
ADD CONSTRAINT auction_lots_current_bidder_roster_id_fkey
FOREIGN KEY (current_bidder_roster_id) REFERENCES rosters(id) ON DELETE SET NULL;

-- 3. auction_lots.winning_roster_id (nullable - SET NULL on delete)
ALTER TABLE auction_lots
DROP CONSTRAINT IF EXISTS auction_lots_winning_roster_id_fkey;

ALTER TABLE auction_lots
ADD CONSTRAINT auction_lots_winning_roster_id_fkey
FOREIGN KEY (winning_roster_id) REFERENCES rosters(id) ON DELETE SET NULL;

-- 4. auction_proxy_bids.roster_id (CASCADE - bid is meaningless without roster)
ALTER TABLE auction_proxy_bids
DROP CONSTRAINT IF EXISTS auction_proxy_bids_roster_id_fkey;

ALTER TABLE auction_proxy_bids
ADD CONSTRAINT auction_proxy_bids_roster_id_fkey
FOREIGN KEY (roster_id) REFERENCES rosters(id) ON DELETE CASCADE;

-- 5. auction_bid_history.roster_id (CASCADE - history entry meaningless without roster)
ALTER TABLE auction_bid_history
DROP CONSTRAINT IF EXISTS auction_bid_history_roster_id_fkey;

ALTER TABLE auction_bid_history
ADD CONSTRAINT auction_bid_history_roster_id_fkey
FOREIGN KEY (roster_id) REFERENCES rosters(id) ON DELETE CASCADE;

-- 6. auction_nomination_queue.roster_id (CASCADE - queue entry meaningless without roster)
-- Note: This table may not exist yet, so we use DO block to conditionally alter
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'auction_nomination_queue') THEN
        ALTER TABLE auction_nomination_queue
        DROP CONSTRAINT IF EXISTS auction_nomination_queue_roster_id_fkey;

        ALTER TABLE auction_nomination_queue
        ADD CONSTRAINT auction_nomination_queue_roster_id_fkey
        FOREIGN KEY (roster_id) REFERENCES rosters(id) ON DELETE CASCADE;
    END IF;
END $$;

COMMENT ON CONSTRAINT auction_lots_nominator_roster_id_fkey ON auction_lots IS
'CASCADE: When roster is deleted, all their nominated lots are deleted';

COMMENT ON CONSTRAINT auction_lots_current_bidder_roster_id_fkey ON auction_lots IS
'SET NULL: When roster is deleted, clear current bidder (lot can continue)';

COMMENT ON CONSTRAINT auction_lots_winning_roster_id_fkey ON auction_lots IS
'SET NULL: When roster is deleted, clear winner (preserves historical data)';
