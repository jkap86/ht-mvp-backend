ALTER TABLE roster_transactions ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_roster_transactions_idempotency
  ON roster_transactions (league_id, roster_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
