-- Per-manager time budgets for chess clock mode
CREATE TABLE draft_chess_clocks (
  id SERIAL PRIMARY KEY,
  draft_id INTEGER NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
  roster_id INTEGER NOT NULL REFERENCES rosters(id) ON DELETE CASCADE,
  remaining_seconds NUMERIC(10, 3) NOT NULL,
  UNIQUE (draft_id, roster_id)
);
CREATE INDEX idx_draft_chess_clocks_draft ON draft_chess_clocks(draft_id);

-- Track time used per pick (for undo support)
ALTER TABLE draft_picks ADD COLUMN time_used_seconds NUMERIC(10, 3) DEFAULT NULL;
