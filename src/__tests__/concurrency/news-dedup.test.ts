import { Pool } from 'pg';
import { NewsRepository, CreateNewsData } from '../../modules/players/news.repository';
import { createNewsHash } from '../../modules/players/news.model';

// Mock logger
jest.mock('../../config/logger.config', () => ({
  logger: {
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const sampleNewsData: CreateNewsData = {
  playerId: 100,
  title: 'Star QB suffers knee injury in practice',
  summary: 'Reports indicate a minor knee sprain',
  source: 'espn',
  sourceUrl: 'https://espn.com/news/123',
  publishedAt: new Date('2025-12-15T10:00:00Z'),
  newsType: 'injury',
  impactLevel: 'high',
};

const dbRow = {
  id: 1,
  player_id: 100,
  title: sampleNewsData.title,
  summary: sampleNewsData.summary,
  content: null,
  source: sampleNewsData.source,
  source_url: sampleNewsData.sourceUrl,
  published_at: sampleNewsData.publishedAt,
  news_type: sampleNewsData.newsType,
  impact_level: sampleNewsData.impactLevel,
  created_at: new Date(),
  updated_at: new Date(),
};

// ===========================================================================
// Test Suite: News Deduplication
// ===========================================================================

describe('News Repository Deduplication', () => {
  describe('createNewsHash', () => {
    it('should produce the same hash for identical inputs', () => {
      const hash1 = createNewsHash('Title A', new Date('2025-01-01'), 'espn');
      const hash2 = createNewsHash('Title A', new Date('2025-01-01'), 'espn');

      expect(hash1).toBe(hash2);
    });

    it('should produce different hashes for different titles', () => {
      const hash1 = createNewsHash('Title A', new Date('2025-01-01'), 'espn');
      const hash2 = createNewsHash('Title B', new Date('2025-01-01'), 'espn');

      expect(hash1).not.toBe(hash2);
    });

    it('should produce different hashes for different dates', () => {
      const hash1 = createNewsHash('Title A', new Date('2025-01-01'), 'espn');
      const hash2 = createNewsHash('Title A', new Date('2025-01-02'), 'espn');

      expect(hash1).not.toBe(hash2);
    });

    it('should produce different hashes for different sources', () => {
      const hash1 = createNewsHash('Title A', new Date('2025-01-01'), 'espn');
      const hash2 = createNewsHash('Title A', new Date('2025-01-01'), 'yahoo');

      expect(hash1).not.toBe(hash2);
    });
  });

  describe('atomic CTE deduplication', () => {
    it('should insert news when no duplicate exists', async () => {
      const mockQuery = jest.fn().mockResolvedValue({
        rows: [dbRow], // CTE returns inserted row
      });
      const pool = { query: mockQuery } as unknown as Pool;
      const repo = new NewsRepository(pool);

      const result = await repo.createNews(sampleNewsData);

      expect(result).toBeDefined();
      expect(result.id).toBe(1);
      expect(result.title).toBe(sampleNewsData.title);

      // Verify the CTE query was used
      const queryCall = mockQuery.mock.calls[0];
      expect(queryCall[0]).toContain('WITH existing AS');
      expect(queryCall[0]).toContain('WHERE NOT EXISTS (SELECT 1 FROM existing)');
      expect(queryCall[0]).toContain('ON CONFLICT (content_hash) DO NOTHING');
    });

    it('should return existing news when duplicate hash exists', async () => {
      const existingRow = { ...dbRow, id: 42 };
      const mockQuery = jest.fn().mockResolvedValue({
        rows: [existingRow], // CTE returns existing row (from "existing" CTE)
      });
      const pool = { query: mockQuery } as unknown as Pool;
      const repo = new NewsRepository(pool);

      const result = await repo.createNews(sampleNewsData);

      expect(result).toBeDefined();
      expect(result.id).toBe(42); // Returns existing, not newly inserted
    });

    it('should use correct content hash for dedup lookup', async () => {
      const expectedHash = createNewsHash(
        sampleNewsData.title,
        sampleNewsData.publishedAt,
        sampleNewsData.source
      );

      const mockQuery = jest.fn().mockResolvedValue({ rows: [dbRow] });
      const pool = { query: mockQuery } as unknown as Pool;
      const repo = new NewsRepository(pool);

      await repo.createNews(sampleNewsData);

      // First parameter should be the content hash
      const queryParams = mockQuery.mock.calls[0][1];
      expect(queryParams[0]).toBe(expectedHash);
    });

    it('should pass correct parameters to the CTE query', async () => {
      const mockQuery = jest.fn().mockResolvedValue({ rows: [dbRow] });
      const pool = { query: mockQuery } as unknown as Pool;
      const repo = new NewsRepository(pool);

      await repo.createNews(sampleNewsData);

      const queryParams = mockQuery.mock.calls[0][1];
      // Parameters: [hash, playerId, title, summary, content, source, sourceUrl, publishedAt, newsType, impactLevel]
      expect(queryParams[1]).toBe(100); // playerId
      expect(queryParams[2]).toBe(sampleNewsData.title);
      expect(queryParams[3]).toBe(sampleNewsData.summary);
      expect(queryParams[4]).toBeNull(); // content (not provided)
      expect(queryParams[5]).toBe('espn');
      expect(queryParams[6]).toBe(sampleNewsData.sourceUrl);
      expect(queryParams[7]).toBe(sampleNewsData.publishedAt);
      expect(queryParams[8]).toBe('injury');
      expect(queryParams[9]).toBe('high');
    });
  });

  describe('concurrent createNews calls simulation', () => {
    it('should return the same news entry when called concurrently with identical data', async () => {
      // Simulate: both calls hit the CTE at the same time.
      // The "existing" CTE is empty for both (no prior row).
      // The "inserted" CTE uses NOT EXISTS, so in Postgres only one INSERT will succeed
      // due to the ON CONFLICT on cache_entry.
      // The CTE returns the inserted row for the winner and the existing row for the loser.

      const mockQuery = jest.fn()
        // Call 1: gets the inserted row
        .mockResolvedValueOnce({ rows: [{ ...dbRow, id: 1 }] })
        // Call 2: gets the existing row (inserted by call 1)
        .mockResolvedValueOnce({ rows: [{ ...dbRow, id: 1 }] });

      const pool = { query: mockQuery } as unknown as Pool;
      const repo = new NewsRepository(pool);

      const [result1, result2] = await Promise.all([
        repo.createNews(sampleNewsData),
        repo.createNews(sampleNewsData),
      ]);

      // Both should return the same news item
      expect(result1.id).toBe(result2.id);
      expect(result1.title).toBe(result2.title);
    });

    it('should allow different news items to be inserted concurrently', async () => {
      const newsData2: CreateNewsData = {
        ...sampleNewsData,
        title: 'Different breaking news story',
        publishedAt: new Date('2025-12-15T11:00:00Z'),
      };

      const dbRow2 = {
        ...dbRow,
        id: 2,
        title: newsData2.title,
        published_at: newsData2.publishedAt,
      };

      const mockQuery = jest.fn()
        .mockResolvedValueOnce({ rows: [dbRow] })
        .mockResolvedValueOnce({ rows: [dbRow2] });

      const pool = { query: mockQuery } as unknown as Pool;
      const repo = new NewsRepository(pool);

      const [result1, result2] = await Promise.all([
        repo.createNews(sampleNewsData),
        repo.createNews(newsData2),
      ]);

      // Different news items should have different IDs
      expect(result1.id).not.toBe(result2.id);
      expect(result1.title).not.toBe(result2.title);
    });
  });

  describe('CTE structure verification', () => {
    it('should use UNION ALL to return either existing or inserted row', async () => {
      const mockQuery = jest.fn().mockResolvedValue({ rows: [dbRow] });
      const pool = { query: mockQuery } as unknown as Pool;
      const repo = new NewsRepository(pool);

      await repo.createNews(sampleNewsData);

      const sql = mockQuery.mock.calls[0][0] as string;
      expect(sql).toContain('UNION ALL');
      expect(sql).toContain('SELECT * FROM existing');
      expect(sql).toContain('SELECT * FROM inserted');
    });

    it('should use ON CONFLICT DO NOTHING for cache entry to handle races', async () => {
      const mockQuery = jest.fn().mockResolvedValue({ rows: [dbRow] });
      const pool = { query: mockQuery } as unknown as Pool;
      const repo = new NewsRepository(pool);

      await repo.createNews(sampleNewsData);

      const sql = mockQuery.mock.calls[0][0] as string;
      expect(sql).toContain('ON CONFLICT (content_hash) DO NOTHING');
    });

    it('should use NOT EXISTS guard to skip insert when hash already cached', async () => {
      const mockQuery = jest.fn().mockResolvedValue({ rows: [dbRow] });
      const pool = { query: mockQuery } as unknown as Pool;
      const repo = new NewsRepository(pool);

      await repo.createNews(sampleNewsData);

      const sql = mockQuery.mock.calls[0][0] as string;
      expect(sql).toContain('WHERE NOT EXISTS (SELECT 1 FROM existing)');
    });
  });

  describe('optional client parameter', () => {
    it('should use provided client instead of pool when given', async () => {
      const mockPoolQuery = jest.fn();
      const mockClientQuery = jest.fn().mockResolvedValue({ rows: [dbRow] });

      const pool = { query: mockPoolQuery } as unknown as Pool;
      const client = { query: mockClientQuery } as any;
      const repo = new NewsRepository(pool);

      await repo.createNews(sampleNewsData, client);

      // Should use client, not pool
      expect(mockClientQuery).toHaveBeenCalled();
      expect(mockPoolQuery).not.toHaveBeenCalled();
    });
  });
});
