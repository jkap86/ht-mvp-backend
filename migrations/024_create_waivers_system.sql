-- Waivers system tables
-- Supports both standard priority waivers and FAAB (Free Agent Acquisition Budget)

-- Waiver type enum
DO $$ BEGIN
    CREATE TYPE waiver_type AS ENUM ('standard', 'faab', 'none');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- Waiver claim status enum
DO $$ BEGIN
    CREATE TYPE waiver_claim_status AS ENUM (
        'pending',      -- Awaiting processing
        'successful',   -- Claim won
        'failed',       -- Lost to higher priority/bid
        'cancelled',    -- User cancelled
        'invalid'       -- Player no longer available
    );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- Waiver priority tracking per league/season
-- Lower priority number = higher priority (1 is highest)
CREATE TABLE IF NOT EXISTS waiver_priority (
    id SERIAL PRIMARY KEY,
    league_id INTEGER NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
    roster_id INTEGER NOT NULL REFERENCES rosters(id) ON DELETE CASCADE,
    season INTEGER NOT NULL,
    priority INTEGER NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,

    UNIQUE(league_id, season, roster_id),
    UNIQUE(league_id, season, priority)
);

-- FAAB budget tracking per roster/season
CREATE TABLE IF NOT EXISTS faab_budgets (
    id SERIAL PRIMARY KEY,
    league_id INTEGER NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
    roster_id INTEGER NOT NULL REFERENCES rosters(id) ON DELETE CASCADE,
    season INTEGER NOT NULL,
    initial_budget INTEGER NOT NULL DEFAULT 100,
    remaining_budget INTEGER NOT NULL DEFAULT 100,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,

    UNIQUE(league_id, season, roster_id),
    CONSTRAINT positive_budget CHECK (remaining_budget >= 0),
    CONSTRAINT budget_not_exceed_initial CHECK (remaining_budget <= initial_budget)
);

-- Pending waiver claims
CREATE TABLE IF NOT EXISTS waiver_claims (
    id SERIAL PRIMARY KEY,
    league_id INTEGER NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
    roster_id INTEGER NOT NULL REFERENCES rosters(id) ON DELETE CASCADE,
    player_id INTEGER NOT NULL REFERENCES players(id),
    drop_player_id INTEGER REFERENCES players(id),  -- Optional player to drop
    bid_amount INTEGER DEFAULT 0,                    -- For FAAB mode
    priority_at_claim INTEGER,                       -- Snapshot of priority when claim made
    status waiver_claim_status NOT NULL DEFAULT 'pending',
    season INTEGER NOT NULL,
    week INTEGER NOT NULL,
    processed_at TIMESTAMPTZ,
    failure_reason TEXT,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Players currently on waiver wire (recently dropped)
CREATE TABLE IF NOT EXISTS waiver_wire (
    id SERIAL PRIMARY KEY,
    league_id INTEGER NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
    player_id INTEGER NOT NULL REFERENCES players(id),
    dropped_by_roster_id INTEGER REFERENCES rosters(id) ON DELETE SET NULL,
    waiver_expires_at TIMESTAMPTZ NOT NULL,
    season INTEGER NOT NULL,
    week INTEGER NOT NULL,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,

    UNIQUE(league_id, player_id)
);

-- Indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_waiver_priority_league_season
    ON waiver_priority(league_id, season);
CREATE INDEX IF NOT EXISTS idx_waiver_priority_roster
    ON waiver_priority(roster_id);

CREATE INDEX IF NOT EXISTS idx_faab_budgets_league_season
    ON faab_budgets(league_id, season);
CREATE INDEX IF NOT EXISTS idx_faab_budgets_roster
    ON faab_budgets(roster_id);

CREATE INDEX IF NOT EXISTS idx_waiver_claims_league_status
    ON waiver_claims(league_id, status);
CREATE INDEX IF NOT EXISTS idx_waiver_claims_roster
    ON waiver_claims(roster_id, status);
CREATE INDEX IF NOT EXISTS idx_waiver_claims_player
    ON waiver_claims(player_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_waiver_claims_pending
    ON waiver_claims(league_id) WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_waiver_wire_league
    ON waiver_wire(league_id);
CREATE INDEX IF NOT EXISTS idx_waiver_wire_expires
    ON waiver_wire(waiver_expires_at);
CREATE INDEX IF NOT EXISTS idx_waiver_wire_player
    ON waiver_wire(player_id);

-- Add updated_at triggers
CREATE TRIGGER update_waiver_priority_updated_at
    BEFORE UPDATE ON waiver_priority
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_faab_budgets_updated_at
    BEFORE UPDATE ON faab_budgets
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_waiver_claims_updated_at
    BEFORE UPDATE ON waiver_claims
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
