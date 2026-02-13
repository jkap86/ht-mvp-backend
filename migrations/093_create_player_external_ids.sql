-- External ID mapping table for provider-agnostic player identity
-- This allows the system to map player IDs from multiple providers (Sleeper, FantasyPros, etc.)
-- to our internal canonical player ID.

CREATE TABLE IF NOT EXISTS player_external_ids (
    id SERIAL PRIMARY KEY,
    player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    provider VARCHAR(50) NOT NULL,
    external_id VARCHAR(100) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,

    -- Each player can have one external ID per provider
    UNIQUE(provider, external_id),
    -- Prevent duplicate mappings for same player-provider pair
    UNIQUE(player_id, provider)
);

-- Indexes for efficient lookups
CREATE INDEX idx_player_external_ids_player ON player_external_ids(player_id);
CREATE INDEX idx_player_external_ids_provider ON player_external_ids(provider, external_id);

-- Trigger for updated_at
CREATE TRIGGER update_player_external_ids_updated_at
    BEFORE UPDATE ON player_external_ids
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Comments
COMMENT ON TABLE player_external_ids IS 'Maps internal player IDs to provider-specific external IDs';
COMMENT ON COLUMN player_external_ids.provider IS 'Stats provider name (sleeper, fantasypros, etc.)';
COMMENT ON COLUMN player_external_ids.external_id IS 'Provider-specific player identifier';
