-- Migration 034: Backfill draft_pick_assets for existing drafts
-- This creates pick assets for any existing drafts that were created before pick trading was implemented

-- Generate pick assets for existing drafts
-- For each draft, create one asset per round per roster in the draft order
INSERT INTO draft_pick_assets (
    league_id,
    draft_id,
    season,
    round,
    original_roster_id,
    current_owner_roster_id,
    original_pick_position
)
SELECT
    d.league_id,
    d.id as draft_id,
    COALESCE(l.season::integer, EXTRACT(YEAR FROM d.created_at)::integer) as season,
    gs.round,
    dord.roster_id as original_roster_id,
    dord.roster_id as current_owner_roster_id,  -- Initially owned by original position holder
    dord.draft_position as original_pick_position
FROM drafts d
CROSS JOIN generate_series(1, d.rounds) AS gs(round)
JOIN draft_order dord ON dord.draft_id = d.id
JOIN leagues l ON l.id = d.league_id
WHERE NOT EXISTS (
    -- Skip if assets already exist for this draft
    SELECT 1 FROM draft_pick_assets dpa
    WHERE dpa.draft_id = d.id
)
ON CONFLICT (league_id, season, round, original_roster_id) DO NOTHING;

-- Log the count of created assets
DO $$
DECLARE
    asset_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO asset_count FROM draft_pick_assets;
    RAISE NOTICE 'Total draft_pick_assets after backfill: %', asset_count;
END $$;
