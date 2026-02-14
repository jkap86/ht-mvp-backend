import { Pool } from 'pg';

// Mock logger
jest.mock('../../config/logger.config', () => ({
  logger: {
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}));

// Mock container
const mockPoolQuery = jest.fn();
const mockPoolConnect = jest.fn();
const mockPool = {
  query: mockPoolQuery,
  connect: mockPoolConnect,
} as unknown as Pool;

jest.mock('../../container', () => ({
  container: {
    resolve: jest.fn().mockImplementation((key: string) => {
      if (key === 'POOL') return mockPool;
      return {};
    }),
    clearInstances: jest.fn(),
  },
  KEYS: {
    POOL: 'POOL',
    SLOW_AUCTION_SERVICE: 'SLOW_AUCTION_SERVICE',
    FAST_AUCTION_SERVICE: 'FAST_AUCTION_SERVICE',
    STATS_PROVIDER: 'STATS_PROVIDER',
  },
}));

// ---------------------------------------------------------------------------
// Test Suite: Advisory Lock-Based Job Overlap Prevention
// ---------------------------------------------------------------------------

describe('Job Overlap Prevention via Advisory Locks', () => {
  let mockClient: { query: jest.Mock; release: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();
    mockClient = {
      query: jest.fn(),
      release: jest.fn(),
    };
    mockPoolConnect.mockResolvedValue(mockClient);
  });

  describe('pg_try_advisory_lock pattern', () => {
    it('should acquire lock and run job when no other instance holds it', async () => {
      // Simulate: lock acquired
      mockClient.query
        .mockResolvedValueOnce({ rows: [{ acquired: true }] }) // pg_try_advisory_lock
        .mockResolvedValueOnce({ rows: [] }); // pg_advisory_unlock

      let jobExecuted = false;
      const runJob = async () => {
        const client = await mockPool.connect();
        try {
          const lockResult = await client.query<{ acquired: boolean }>(
            'SELECT pg_try_advisory_lock($1) as acquired',
            [900000007]
          );

          if (!lockResult.rows[0].acquired) {
            return;
          }

          try {
            // Simulate job work
            jobExecuted = true;
          } finally {
            await client.query('SELECT pg_advisory_unlock($1)', [900000007]);
          }
        } finally {
          client.release();
        }
      };

      await runJob();

      expect(jobExecuted).toBe(true);
      expect(mockClient.query).toHaveBeenCalledWith(
        'SELECT pg_try_advisory_lock($1) as acquired',
        [900000007]
      );
      expect(mockClient.query).toHaveBeenCalledWith(
        'SELECT pg_advisory_unlock($1)',
        [900000007]
      );
      expect(mockClient.release).toHaveBeenCalled();
    });

    it('should skip job when lock is already held by another instance', async () => {
      // Simulate: lock NOT acquired
      mockClient.query
        .mockResolvedValueOnce({ rows: [{ acquired: false }] }); // pg_try_advisory_lock

      let jobExecuted = false;
      const runJob = async () => {
        const client = await mockPool.connect();
        try {
          const lockResult = await client.query<{ acquired: boolean }>(
            'SELECT pg_try_advisory_lock($1) as acquired',
            [900000007]
          );

          if (!lockResult.rows[0].acquired) {
            return; // Skip - another instance has the lock
          }

          jobExecuted = true;
        } finally {
          client.release();
        }
      };

      await runJob();

      expect(jobExecuted).toBe(false);
      expect(mockClient.release).toHaveBeenCalled();
    });

    it('should release connection even when job throws', async () => {
      mockClient.query
        .mockResolvedValueOnce({ rows: [{ acquired: true }] })
        .mockResolvedValueOnce({ rows: [] }); // unlock

      const runJob = async () => {
        const client = await mockPool.connect();
        try {
          const lockResult = await client.query<{ acquired: boolean }>(
            'SELECT pg_try_advisory_lock($1) as acquired',
            [900000007]
          );

          if (!lockResult.rows[0].acquired) return;

          try {
            throw new Error('Job failed');
          } finally {
            await client.query('SELECT pg_advisory_unlock($1)', [900000007]);
          }
        } finally {
          client.release();
        }
      };

      await expect(runJob()).rejects.toThrow('Job failed');
      expect(mockClient.query).toHaveBeenCalledWith(
        'SELECT pg_advisory_unlock($1)',
        [900000007]
      );
      expect(mockClient.release).toHaveBeenCalled();
    });
  });

  describe('concurrent job execution simulation', () => {
    it('should only allow one of two concurrent job instances to execute', async () => {
      let lockHeld = false;
      let executions = 0;

      // Create two separate mock clients for two "instances"
      const client1: any = {
        query: jest.fn().mockImplementation(async (sql: string) => {
          if (sql.includes('pg_try_advisory_lock')) {
            // Simulate: first caller gets lock, second doesn't
            if (!lockHeld) {
              lockHeld = true;
              return { rows: [{ acquired: true }] };
            }
            return { rows: [{ acquired: false }] };
          }
          if (sql.includes('pg_advisory_unlock')) {
            lockHeld = false;
            return { rows: [] };
          }
          return { rows: [] };
        }),
        release: jest.fn(),
      };
      const client2: any = {
        query: jest.fn().mockImplementation(async (sql: string) => {
          if (sql.includes('pg_try_advisory_lock')) {
            if (!lockHeld) {
              lockHeld = true;
              return { rows: [{ acquired: true }] };
            }
            return { rows: [{ acquired: false }] };
          }
          if (sql.includes('pg_advisory_unlock')) {
            lockHeld = false;
            return { rows: [] };
          }
          return { rows: [] };
        }),
        release: jest.fn(),
      };

      const runJob = async (client: any) => {
        try {
          const lockResult = await client.query(
            'SELECT pg_try_advisory_lock($1) as acquired',
            [900000007]
          );

          if (!lockResult.rows[0].acquired) {
            return false;
          }

          try {
            executions++;
            // Simulate work
            await new Promise((r) => setTimeout(r, 10));
          } finally {
            await client.query('SELECT pg_advisory_unlock($1)', [900000007]);
          }
          return true;
        } finally {
          client.release();
        }
      };

      // Run both "instances" concurrently
      const [result1, result2] = await Promise.all([
        runJob(client1),
        runJob(client2),
      ]);

      // Exactly one should have executed
      expect(executions).toBe(1);
      const successes = [result1, result2].filter(Boolean);
      expect(successes).toHaveLength(1);
    });

    it('should allow second instance after first releases lock', async () => {
      let lockHolder: string | null = null;
      const executionOrder: string[] = [];

      const createClient = (name: string): any => ({
        query: jest.fn().mockImplementation(async (sql: string) => {
          if (sql.includes('pg_try_advisory_lock')) {
            if (lockHolder === null) {
              lockHolder = name;
              return { rows: [{ acquired: true }] };
            }
            return { rows: [{ acquired: false }] };
          }
          if (sql.includes('pg_advisory_unlock')) {
            lockHolder = null;
            return { rows: [] };
          }
          return { rows: [] };
        }),
        release: jest.fn(),
      });

      const runJob = async (client: any, name: string): Promise<boolean> => {
        try {
          const lockResult = await client.query(
            'SELECT pg_try_advisory_lock($1) as acquired',
            [900000007]
          );

          if (!lockResult.rows[0].acquired) return false;

          try {
            executionOrder.push(name);
          } finally {
            await client.query('SELECT pg_advisory_unlock($1)', [900000007]);
          }
          return true;
        } finally {
          client.release();
        }
      };

      // First instance acquires and completes
      const client1 = createClient('instance-1');
      await runJob(client1, 'instance-1');

      // Second instance acquires after first releases
      const client2 = createClient('instance-2');
      await runJob(client2, 'instance-2');

      expect(executionOrder).toEqual(['instance-1', 'instance-2']);
    });
  });

  describe('lock ID uniqueness', () => {
    it('should use different lock IDs for different job types', () => {
      // Verify the lock IDs from our job files are distinct
      const { getLockId, LockDomain } = require('../../shared/locks');

      const slowAuctionLock = getLockId(LockDomain.JOB, 7);
      const nominationLock = getLockId(LockDomain.JOB, 8);
      const trendingLock = getLockId(LockDomain.JOB, 6);

      expect(slowAuctionLock).not.toBe(nominationLock);
      expect(slowAuctionLock).not.toBe(trendingLock);
      expect(nominationLock).not.toBe(trendingLock);

      // All should be in JOB domain (900M+)
      expect(slowAuctionLock).toBeGreaterThan(900_000_000);
      expect(nominationLock).toBeGreaterThan(900_000_000);
      expect(trendingLock).toBeGreaterThan(900_000_000);
    });
  });
});
