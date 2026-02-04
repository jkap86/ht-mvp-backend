-- League dues configuration table
CREATE TABLE IF NOT EXISTS league_dues (
    id SERIAL PRIMARY KEY,
    league_id INTEGER NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
    buy_in_amount DECIMAL(10, 2) NOT NULL DEFAULT 0,
    payout_structure JSONB DEFAULT '{}',  -- e.g., {"1st": 70, "2nd": 20, "3rd": 10} (percentages)
    currency VARCHAR(10) DEFAULT 'USD',
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(league_id)
);

-- Dues payment tracking table
CREATE TABLE IF NOT EXISTS dues_payments (
    id SERIAL PRIMARY KEY,
    league_id INTEGER NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
    roster_id INTEGER NOT NULL,
    is_paid BOOLEAN DEFAULT false,
    paid_at TIMESTAMPTZ,
    marked_by_user_id UUID REFERENCES users(id),
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(league_id, roster_id)
);

-- Index for finding dues config by league
CREATE INDEX IF NOT EXISTS idx_league_dues_league
    ON league_dues(league_id);

-- Index for finding payments by league
CREATE INDEX IF NOT EXISTS idx_dues_payments_league
    ON dues_payments(league_id);

-- Index for finding payments by roster
CREATE INDEX IF NOT EXISTS idx_dues_payments_roster
    ON dues_payments(roster_id);

-- Trigger to update updated_at on league_dues changes
DROP TRIGGER IF EXISTS update_league_dues_updated_at ON league_dues;
CREATE TRIGGER update_league_dues_updated_at
    BEFORE UPDATE ON league_dues
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Trigger to update updated_at on dues_payments changes
DROP TRIGGER IF EXISTS update_dues_payments_updated_at ON dues_payments;
CREATE TRIGGER update_dues_payments_updated_at
    BEFORE UPDATE ON dues_payments
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
