-- Migration 080: Create keeper_selections table
-- Purpose: Track which players/assets a roster is keeping from previous season

-- Keeper selections for dynasty/keeper leagues
CREATE TABLE IF NOT EXISTS keeper_selections (
    id SERIAL PRIMARY KEY,

    -- Which season is this keeper being kept FOR
    league_season_id INTEGER NOT NULL REFERENCES league_seasons(id) ON DELETE CASCADE,

    -- Which roster is keeping the player
    roster_id INTEGER NOT NULL REFERENCES rosters(id) ON DELETE CASCADE,

    -- Which player/asset is being kept (XOR: either player OR pick asset, not both)
    player_id INTEGER REFERENCES players(id),
    draft_pick_asset_id INTEGER REFERENCES draft_pick_assets(id),

    -- Keeper cost (for leagues with draft pick cost)
    keeper_round_cost INTEGER,

    -- Selection timestamp
    selected_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,

    -- Each roster can only keep a given player/asset once per season
    UNIQUE(league_season_id, roster_id, player_id),
    UNIQUE(league_season_id, roster_id, draft_pick_asset_id),

    -- Must keep either a player OR a pick asset, not both
    CHECK (
        (player_id IS NOT NULL AND draft_pick_asset_id IS NULL) OR
        (player_id IS NULL AND draft_pick_asset_id IS NOT NULL)
    )
);

-- Indexes for performance
CREATE INDEX idx_keeper_selections_season ON keeper_selections(league_season_id);
CREATE INDEX idx_keeper_selections_roster ON keeper_selections(roster_id);
CREATE INDEX idx_keeper_selections_player ON keeper_selections(player_id) WHERE player_id IS NOT NULL;
CREATE INDEX idx_keeper_selections_pick_asset ON keeper_selections(draft_pick_asset_id) WHERE draft_pick_asset_id IS NOT NULL;

-- Comments
COMMENT ON TABLE keeper_selections IS 'Tracks which players/assets a roster is keeping from previous season';
COMMENT ON COLUMN keeper_selections.league_season_id IS 'The season this keeper selection is FOR (not FROM)';
COMMENT ON COLUMN keeper_selections.roster_id IS 'The roster keeping the player';
COMMENT ON COLUMN keeper_selections.player_id IS 'The player being kept (NULL if keeping a pick asset)';
COMMENT ON COLUMN keeper_selections.draft_pick_asset_id IS 'The pick asset being kept (NULL if keeping a player)';
COMMENT ON COLUMN keeper_selections.keeper_round_cost IS 'Which round pick this keeper costs (for cost-based keeper leagues)';
