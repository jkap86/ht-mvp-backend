-- Draft picks table
CREATE TABLE IF NOT EXISTS draft_picks (
    id SERIAL PRIMARY KEY,
    draft_id INTEGER NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
    pick_number INTEGER NOT NULL,
    round INTEGER NOT NULL,
    pick_in_round INTEGER NOT NULL,
    roster_id INTEGER NOT NULL REFERENCES rosters(id) ON DELETE CASCADE,
    player_id INTEGER,
    is_auto_pick BOOLEAN DEFAULT FALSE,
    picked_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(draft_id, pick_number),
    UNIQUE(draft_id, player_id)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_draft_picks_draft_id ON draft_picks(draft_id);
CREATE INDEX IF NOT EXISTS idx_draft_picks_roster_id ON draft_picks(roster_id);
CREATE INDEX IF NOT EXISTS idx_draft_picks_player_id ON draft_picks(player_id);
