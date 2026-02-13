-- Backfill player_external_ids table from existing sleeper_id and cfbd_id columns
-- This migration populates the new external_ids table while keeping the legacy columns
-- for backward compatibility during the transition period.

-- Backfill from existing sleeper_id column (NFL players)
INSERT INTO player_external_ids (player_id, provider, external_id)
SELECT id, 'sleeper', sleeper_id
FROM players
WHERE sleeper_id IS NOT NULL
ON CONFLICT (provider, external_id) DO NOTHING;

-- Backfill from existing cfbd_id column (College players)
INSERT INTO player_external_ids (player_id, provider, external_id)
SELECT id, 'cfbd', cfbd_id::TEXT
FROM players
WHERE cfbd_id IS NOT NULL
ON CONFLICT (provider, external_id) DO NOTHING;

-- Note: We intentionally keep the sleeper_id and cfbd_id columns in the players table
-- for backward compatibility. They will be removed in a future cleanup migration
-- after validating that the new provider system is working correctly.
