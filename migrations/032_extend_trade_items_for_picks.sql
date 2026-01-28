-- Extend trade_items to support draft pick trades
-- Allows mixed trades with both players and picks

-- Add item_type to distinguish players from picks
ALTER TABLE trade_items
    ADD COLUMN IF NOT EXISTS item_type VARCHAR(20) DEFAULT 'player';

-- Add constraint for item_type values
DO $$ BEGIN
    ALTER TABLE trade_items
        ADD CONSTRAINT trade_items_type_check
        CHECK (item_type IN ('player', 'draft_pick'));
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- Make player_id nullable (picks don't have a player_id)
ALTER TABLE trade_items
    ALTER COLUMN player_id DROP NOT NULL;

-- Add draft pick asset reference
ALTER TABLE trade_items
    ADD COLUMN IF NOT EXISTS draft_pick_asset_id INTEGER REFERENCES draft_pick_assets(id);

-- Snapshot pick info at trade time (for history, similar to player_name snapshot)
ALTER TABLE trade_items
    ADD COLUMN IF NOT EXISTS pick_season INTEGER,
    ADD COLUMN IF NOT EXISTS pick_round INTEGER,
    ADD COLUMN IF NOT EXISTS pick_original_team VARCHAR(100);

-- Constraint: must have either player_id OR draft_pick_asset_id based on item_type
DO $$ BEGIN
    ALTER TABLE trade_items
        ADD CONSTRAINT trade_items_has_asset
        CHECK (
            (item_type = 'player' AND player_id IS NOT NULL) OR
            (item_type = 'draft_pick' AND draft_pick_asset_id IS NOT NULL)
        );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- Index for pick asset queries
CREATE INDEX IF NOT EXISTS idx_trade_items_pick_asset ON trade_items(draft_pick_asset_id) WHERE draft_pick_asset_id IS NOT NULL;

COMMENT ON COLUMN trade_items.item_type IS 'Type of trade item: player or draft_pick';
COMMENT ON COLUMN trade_items.draft_pick_asset_id IS 'Reference to draft_pick_assets for pick trades';
COMMENT ON COLUMN trade_items.pick_season IS 'Snapshot: season of the traded pick';
COMMENT ON COLUMN trade_items.pick_round IS 'Snapshot: round of the traded pick';
COMMENT ON COLUMN trade_items.pick_original_team IS 'Snapshot: original team name who was assigned the pick';
