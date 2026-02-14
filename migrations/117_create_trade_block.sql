CREATE TABLE trade_block_items (
  id BIGSERIAL PRIMARY KEY,
  league_id BIGINT NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  roster_id BIGINT NOT NULL REFERENCES rosters(id) ON DELETE CASCADE,
  player_id INTEGER NOT NULL,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (league_id, roster_id, player_id)
);

CREATE INDEX idx_trade_block_league ON trade_block_items(league_id);
CREATE INDEX idx_trade_block_roster ON trade_block_items(roster_id);

CREATE TRIGGER set_trade_block_updated_at BEFORE UPDATE ON trade_block_items
  FOR EACH ROW EXECUTE FUNCTION trigger_set_timestamp();
