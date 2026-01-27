-- League invitations table for direct commissioner invites
CREATE TABLE IF NOT EXISTS league_invitations (
    id SERIAL PRIMARY KEY,
    league_id INTEGER NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
    invited_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    invited_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE SET NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'accepted', 'declined', 'expired')),
    message TEXT,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    responded_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ DEFAULT (CURRENT_TIMESTAMP + INTERVAL '7 days')
);

-- Partial unique index to prevent duplicate pending invites
CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_pending_invite
    ON league_invitations(league_id, invited_user_id) WHERE status = 'pending';

-- Index for finding user's pending invites
CREATE INDEX IF NOT EXISTS idx_invitations_user_pending
    ON league_invitations(invited_user_id) WHERE status = 'pending';

-- Index for finding league's invitations
CREATE INDEX IF NOT EXISTS idx_invitations_league
    ON league_invitations(league_id);

-- Trigger to update updated_at on changes
DROP TRIGGER IF EXISTS update_league_invitations_updated_at ON league_invitations;
CREATE TRIGGER update_league_invitations_updated_at
    BEFORE UPDATE ON league_invitations
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
