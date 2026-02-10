-- Migration: Create player news tables
-- Stream A: Player News System (A1.1)

-- Player news table for storing news articles and updates
CREATE TABLE IF NOT EXISTS player_news (
    id SERIAL PRIMARY KEY,
    player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    title VARCHAR(500) NOT NULL,
    summary TEXT,
    content TEXT,
    source VARCHAR(100) NOT NULL, -- 'sleeper', 'espn', 'rotoworld', etc.
    source_url VARCHAR(1000),
    published_at TIMESTAMP WITH TIME ZONE NOT NULL,
    news_type VARCHAR(50) NOT NULL, -- 'injury', 'transaction', 'performance', 'depth_chart', 'general'
    impact_level VARCHAR(20) NOT NULL DEFAULT 'normal', -- 'critical', 'high', 'normal', 'low'
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Cache table for deduplication of news items
CREATE TABLE IF NOT EXISTS player_news_cache (
    id SERIAL PRIMARY KEY,
    content_hash VARCHAR(64) NOT NULL UNIQUE, -- SHA-256 hash of title + published_at + source
    player_id INTEGER NOT NULL,
    news_id INTEGER REFERENCES player_news(id) ON DELETE CASCADE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for efficient queries
CREATE INDEX idx_player_news_player_id ON player_news(player_id);
CREATE INDEX idx_player_news_published_at ON player_news(published_at DESC);
CREATE INDEX idx_player_news_news_type ON player_news(news_type);
CREATE INDEX idx_player_news_impact_level ON player_news(impact_level);
CREATE INDEX idx_player_news_source ON player_news(source);

-- Composite index for common queries (player news ordered by date)
CREATE INDEX idx_player_news_player_date ON player_news(player_id, published_at DESC);

-- Index for breaking news queries (critical/high impact, recent)
CREATE INDEX idx_player_news_breaking ON player_news(impact_level, published_at DESC)
WHERE impact_level IN ('critical', 'high');

-- Index for cache lookups
CREATE INDEX idx_player_news_cache_hash ON player_news_cache(content_hash);

-- Add comments
COMMENT ON TABLE player_news IS 'Stores player news articles and updates from various sources';
COMMENT ON TABLE player_news_cache IS 'Deduplication cache for news items using content hash';
COMMENT ON COLUMN player_news.impact_level IS 'Severity of news impact: critical (major injury/suspension), high (questionable status), normal (general news), low (minor updates)';
COMMENT ON COLUMN player_news.news_type IS 'Category of news: injury, transaction, performance, depth_chart, general';
