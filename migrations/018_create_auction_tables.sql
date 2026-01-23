-- Auction lots table (each nomination is a "lot")
CREATE TABLE IF NOT EXISTS auction_lots (
    id SERIAL PRIMARY KEY,
    draft_id INTEGER NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
    player_id INTEGER NOT NULL REFERENCES players(id),
    nominator_roster_id INTEGER NOT NULL REFERENCES rosters(id),

    -- Bidding state
    current_bid INTEGER NOT NULL DEFAULT 1,
    current_bidder_roster_id INTEGER REFERENCES rosters(id),
    bid_count INTEGER DEFAULT 0,

    -- Timing
    bid_deadline TIMESTAMPTZ,

    -- Status: pending, active, won, passed
    status VARCHAR(20) DEFAULT 'pending',

    -- Result
    winning_roster_id INTEGER REFERENCES rosters(id),
    winning_bid INTEGER,

    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for auction_lots
CREATE INDEX IF NOT EXISTS idx_auction_lots_draft_id ON auction_lots(draft_id);
CREATE INDEX IF NOT EXISTS idx_auction_lots_status ON auction_lots(status);
CREATE INDEX IF NOT EXISTS idx_auction_lots_deadline ON auction_lots(bid_deadline)
    WHERE status = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS idx_auction_lots_draft_player
    ON auction_lots(draft_id, player_id);

-- Proxy bids (max bid user is willing to pay)
CREATE TABLE IF NOT EXISTS auction_proxy_bids (
    id SERIAL PRIMARY KEY,
    lot_id INTEGER NOT NULL REFERENCES auction_lots(id) ON DELETE CASCADE,
    roster_id INTEGER NOT NULL REFERENCES rosters(id),
    max_bid INTEGER NOT NULL,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,

    UNIQUE(lot_id, roster_id)
);

-- Index for proxy bids
CREATE INDEX IF NOT EXISTS idx_auction_proxy_bids_lot_id ON auction_proxy_bids(lot_id);

-- Bid history (optional but useful for audit trail)
CREATE TABLE IF NOT EXISTS auction_bid_history (
    id SERIAL PRIMARY KEY,
    lot_id INTEGER NOT NULL REFERENCES auction_lots(id) ON DELETE CASCADE,
    roster_id INTEGER NOT NULL REFERENCES rosters(id),
    bid_amount INTEGER NOT NULL,
    is_proxy BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_auction_bid_history_lot_id ON auction_bid_history(lot_id);

-- Nomination queue (pre-set who you'll nominate next)
CREATE TABLE IF NOT EXISTS auction_nomination_queue (
    id SERIAL PRIMARY KEY,
    draft_id INTEGER NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
    roster_id INTEGER NOT NULL REFERENCES rosters(id),
    player_id INTEGER NOT NULL REFERENCES players(id),
    queue_position INTEGER NOT NULL,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,

    UNIQUE(draft_id, roster_id, player_id)
);

CREATE INDEX IF NOT EXISTS idx_auction_nomination_queue_draft_roster
    ON auction_nomination_queue(draft_id, roster_id);

-- Trigger for updated_at on auction_lots
DROP TRIGGER IF EXISTS update_auction_lots_updated_at ON auction_lots;
CREATE TRIGGER update_auction_lots_updated_at
    BEFORE UPDATE ON auction_lots
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Trigger for updated_at on auction_proxy_bids
DROP TRIGGER IF EXISTS update_auction_proxy_bids_updated_at ON auction_proxy_bids;
CREATE TRIGGER update_auction_proxy_bids_updated_at
    BEFORE UPDATE ON auction_proxy_bids
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Comments
COMMENT ON TABLE auction_lots IS 'Each nominated player in a slow auction';
COMMENT ON TABLE auction_proxy_bids IS 'Max bid a user will auto-bid up to';
COMMENT ON TABLE auction_bid_history IS 'Audit trail of all bids';
COMMENT ON TABLE auction_nomination_queue IS 'Pre-set nomination order per user';
