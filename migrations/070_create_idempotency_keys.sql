-- Central idempotency key storage for safe request retries.
-- Used by the idempotency middleware to detect and replay duplicate requests.
CREATE TABLE IF NOT EXISTS idempotency_keys (
    id SERIAL PRIMARY KEY,
    idempotency_key VARCHAR(255) NOT NULL,
    endpoint VARCHAR(512) NOT NULL,
    method VARCHAR(10) NOT NULL,
    user_id UUID NOT NULL REFERENCES users(id),
    response_status INTEGER NOT NULL,
    response_body JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '24 hours'
);

-- Unique per user + endpoint + key combination
CREATE UNIQUE INDEX IF NOT EXISTS idx_idempotency_keys_unique
    ON idempotency_keys (idempotency_key, endpoint, user_id);

-- For periodic cleanup of expired keys
CREATE INDEX IF NOT EXISTS idx_idempotency_keys_expires
    ON idempotency_keys (expires_at);
