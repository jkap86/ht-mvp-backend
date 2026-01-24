-- Weekly player stats (populated from external stats API)
CREATE TABLE IF NOT EXISTS player_stats (
    id SERIAL PRIMARY KEY,
    player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    season INTEGER NOT NULL,
    week INTEGER NOT NULL,
    -- Passing
    pass_yards INTEGER DEFAULT 0,
    pass_td INTEGER DEFAULT 0,
    pass_int INTEGER DEFAULT 0,
    -- Rushing
    rush_yards INTEGER DEFAULT 0,
    rush_td INTEGER DEFAULT 0,
    -- Receiving
    receptions INTEGER DEFAULT 0,
    rec_yards INTEGER DEFAULT 0,
    rec_td INTEGER DEFAULT 0,
    -- Misc
    fumbles_lost INTEGER DEFAULT 0,
    two_pt_conversions INTEGER DEFAULT 0,
    -- Kicking
    fg_made INTEGER DEFAULT 0,
    fg_missed INTEGER DEFAULT 0,
    pat_made INTEGER DEFAULT 0,
    pat_missed INTEGER DEFAULT 0,
    -- Defense (team defense)
    def_td INTEGER DEFAULT 0,
    def_int INTEGER DEFAULT 0,
    def_sacks DECIMAL(4,1) DEFAULT 0,
    def_fumble_rec INTEGER DEFAULT 0,
    def_safety INTEGER DEFAULT 0,
    def_points_allowed INTEGER DEFAULT 0,
    -- Timestamps
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(player_id, season, week)
);

-- League schedule (matchups per week)
CREATE TABLE IF NOT EXISTS matchups (
    id SERIAL PRIMARY KEY,
    league_id INTEGER NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
    season INTEGER NOT NULL,
    week INTEGER NOT NULL,
    roster1_id INTEGER NOT NULL REFERENCES rosters(id) ON DELETE CASCADE,
    roster2_id INTEGER NOT NULL REFERENCES rosters(id) ON DELETE CASCADE,
    roster1_points DECIMAL(6,2),
    roster2_points DECIMAL(6,2),
    is_playoff BOOLEAN DEFAULT FALSE,
    is_final BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(league_id, season, week, roster1_id)
);

-- Weekly roster lineups (starters per week)
CREATE TABLE IF NOT EXISTS roster_lineups (
    id SERIAL PRIMARY KEY,
    roster_id INTEGER NOT NULL REFERENCES rosters(id) ON DELETE CASCADE,
    season INTEGER NOT NULL,
    week INTEGER NOT NULL,
    -- Stored as JSONB: { "QB": [playerId], "RB": [id1, id2], "WR": [...], "FLEX": [...], "BN": [...] }
    lineup JSONB NOT NULL DEFAULT '{}',
    total_points DECIMAL(6,2),
    is_locked BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(roster_id, season, week)
);

-- Roster transactions (add/drop history)
CREATE TABLE IF NOT EXISTS roster_transactions (
    id SERIAL PRIMARY KEY,
    league_id INTEGER NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
    roster_id INTEGER NOT NULL REFERENCES rosters(id) ON DELETE CASCADE,
    player_id INTEGER NOT NULL REFERENCES players(id),
    transaction_type VARCHAR(20) NOT NULL, -- 'add', 'drop', 'trade'
    related_transaction_id INTEGER, -- For trades, links add/drop pairs
    season INTEGER NOT NULL,
    week INTEGER NOT NULL,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_player_stats_lookup ON player_stats(player_id, season, week);
CREATE INDEX IF NOT EXISTS idx_matchups_league_week ON matchups(league_id, season, week);
CREATE INDEX IF NOT EXISTS idx_roster_lineups_lookup ON roster_lineups(roster_id, season, week);
CREATE INDEX IF NOT EXISTS idx_roster_transactions_roster ON roster_transactions(roster_id, season);
