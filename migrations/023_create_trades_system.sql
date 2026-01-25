-- Trades system tables
-- Supports trade proposals, counter-offers, voting, and execution

-- Trade status enum
DO $$ BEGIN
    CREATE TYPE trade_status AS ENUM (
        'pending',      -- Awaiting recipient response
        'countered',    -- Counter-offer made
        'accepted',     -- Accepted, may be pending review
        'in_review',    -- Commissioner or league review period
        'completed',    -- Trade finalized, players swapped
        'rejected',     -- Recipient rejected
        'cancelled',    -- Proposer cancelled
        'expired',      -- Auto-expired after deadline
        'vetoed'        -- Vetoed during review
    );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- Main trades table
CREATE TABLE IF NOT EXISTS trades (
    id SERIAL PRIMARY KEY,
    league_id INTEGER NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
    proposer_roster_id INTEGER NOT NULL REFERENCES rosters(id) ON DELETE CASCADE,
    recipient_roster_id INTEGER NOT NULL REFERENCES rosters(id) ON DELETE CASCADE,
    status trade_status NOT NULL DEFAULT 'pending',

    -- For counter-offers: link to original trade
    parent_trade_id INTEGER REFERENCES trades(id) ON DELETE SET NULL,

    -- Expiration and review timing
    expires_at TIMESTAMPTZ NOT NULL,
    review_starts_at TIMESTAMPTZ,
    review_ends_at TIMESTAMPTZ,

    -- Optional message from proposer
    message TEXT,

    -- Season tracking
    season INTEGER NOT NULL,
    week INTEGER NOT NULL,

    -- Timestamps
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMPTZ
);

-- Trade items (players involved in the trade)
CREATE TABLE IF NOT EXISTS trade_items (
    id SERIAL PRIMARY KEY,
    trade_id INTEGER NOT NULL REFERENCES trades(id) ON DELETE CASCADE,
    player_id INTEGER NOT NULL REFERENCES players(id),
    from_roster_id INTEGER NOT NULL REFERENCES rosters(id) ON DELETE CASCADE,
    to_roster_id INTEGER NOT NULL REFERENCES rosters(id) ON DELETE CASCADE,

    -- Snapshot player info at trade time (for history)
    player_name VARCHAR(100) NOT NULL,
    player_position VARCHAR(10),
    player_team VARCHAR(5),

    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Trade votes (for league voting feature)
CREATE TABLE IF NOT EXISTS trade_votes (
    id SERIAL PRIMARY KEY,
    trade_id INTEGER NOT NULL REFERENCES trades(id) ON DELETE CASCADE,
    roster_id INTEGER NOT NULL REFERENCES rosters(id) ON DELETE CASCADE,
    vote VARCHAR(10) NOT NULL CHECK (vote IN ('approve', 'veto')),
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,

    -- Each roster can only vote once per trade
    UNIQUE(trade_id, roster_id)
);

-- Indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_trades_league_status ON trades(league_id, status);
CREATE INDEX IF NOT EXISTS idx_trades_proposer ON trades(proposer_roster_id, status);
CREATE INDEX IF NOT EXISTS idx_trades_recipient ON trades(recipient_roster_id, status);
CREATE INDEX IF NOT EXISTS idx_trades_expires ON trades(expires_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_trades_review ON trades(review_ends_at) WHERE status IN ('accepted', 'in_review');
CREATE INDEX IF NOT EXISTS idx_trade_items_trade ON trade_items(trade_id);
CREATE INDEX IF NOT EXISTS idx_trade_items_player ON trade_items(player_id);
CREATE INDEX IF NOT EXISTS idx_trade_votes_trade ON trade_votes(trade_id);

-- Add updated_at trigger
CREATE TRIGGER update_trades_updated_at
    BEFORE UPDATE ON trades
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
