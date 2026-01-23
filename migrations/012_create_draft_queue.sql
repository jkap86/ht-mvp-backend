-- Draft queue table - pre-ranked players for auto-pick
CREATE TABLE IF NOT EXISTS draft_queue (
    id SERIAL PRIMARY KEY,
    draft_id INTEGER NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
    roster_id INTEGER NOT NULL REFERENCES rosters(id) ON DELETE CASCADE,
    player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    queue_position INTEGER NOT NULL,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(draft_id, roster_id, player_id),
    UNIQUE(draft_id, roster_id, queue_position)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_draft_queue_draft_roster ON draft_queue(draft_id, roster_id);
CREATE INDEX IF NOT EXISTS idx_draft_queue_player ON draft_queue(player_id);
