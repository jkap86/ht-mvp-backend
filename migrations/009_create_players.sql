-- Players table (NFL player data from Sleeper API)
CREATE TABLE IF NOT EXISTS players (
    id SERIAL PRIMARY KEY,
    sleeper_id VARCHAR(50) NOT NULL UNIQUE,
    first_name VARCHAR(100),
    last_name VARCHAR(100),
    full_name VARCHAR(200) NOT NULL,
    fantasy_positions TEXT[],
    position VARCHAR(10),
    team VARCHAR(10),
    years_exp INTEGER,
    age INTEGER,
    active BOOLEAN DEFAULT true,
    status VARCHAR(50),
    injury_status VARCHAR(50),
    jersey_number INTEGER,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_players_sleeper_id ON players(sleeper_id);
CREATE INDEX IF NOT EXISTS idx_players_position ON players(position);
CREATE INDEX IF NOT EXISTS idx_players_team ON players(team);
CREATE INDEX IF NOT EXISTS idx_players_active ON players(active);
CREATE INDEX IF NOT EXISTS idx_players_full_name ON players(full_name);
CREATE INDEX IF NOT EXISTS idx_players_fantasy_positions ON players USING GIN(fantasy_positions);

-- Trigger for updated_at
DROP TRIGGER IF EXISTS update_players_updated_at ON players;
CREATE TRIGGER update_players_updated_at
    BEFORE UPDATE ON players
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
