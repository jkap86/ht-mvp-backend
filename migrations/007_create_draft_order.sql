-- Draft order table
CREATE TABLE IF NOT EXISTS draft_order (
    id SERIAL PRIMARY KEY,
    draft_id INTEGER NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
    roster_id INTEGER NOT NULL REFERENCES rosters(id) ON DELETE CASCADE,
    draft_position INTEGER NOT NULL,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(draft_id, roster_id),
    UNIQUE(draft_id, draft_position)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_draft_order_draft_id ON draft_order(draft_id);
CREATE INDEX IF NOT EXISTS idx_draft_order_roster_id ON draft_order(roster_id);
