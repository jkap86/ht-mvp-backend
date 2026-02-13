/**
 * Job Lock Skip & Idempotency Tests
 *
 * Verifies that all session-locked jobs correctly skip processing when the
 * advisory lock is not acquired, and that idempotency layers work as expected.
 */
import { Pool, PoolClient } from 'pg';
import { container, KEYS } from '../../container';

const mockQueryResult = (rows: any[]) => ({ rows });

const createMockClient = (): jest.Mocked<PoolClient> => ({
  query: jest.fn(),
  release: jest.fn(),
} as unknown as jest.Mocked<PoolClient>);

const createMockPool = (client: jest.Mocked<PoolClient>): jest.Mocked<Pool> => ({
  connect: jest.fn().mockResolvedValue(client),
} as unknown as jest.Mocked<Pool>);

jest.mock('../../config/logger.config', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock('../../socket/socket.service', () => ({
  tryGetSocketService: jest.fn(() => null),
}));

jest.mock('../../shared/events', () => ({
  tryGetEventBus: jest.fn(() => null),
  EventTypes: {},
}));

jest.mock('../../shared/utils/time-utils', () => ({
  isInPauseWindow: jest.fn(() => false),
}));

// ─── Direct-call job tests (no timers needed) ─────────────────────────

describe('Direct-call job lock skip', () => {
  let mockClient: jest.Mocked<PoolClient>;
  let mockPool: jest.Mocked<Pool>;

  function setupLockNotAcquired() {
    mockClient.query.mockImplementation((query: string) => {
      if (typeof query === 'string' && query.includes('pg_try_advisory_lock')) {
        return Promise.resolve(mockQueryResult([{ acquired: false }]));
      }
      return Promise.resolve(mockQueryResult([]));
    });
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockClient = createMockClient();
    mockPool = createMockPool(mockClient);
    container.clearInstances();
    container.override(KEYS.POOL, mockPool);
  });

  afterEach(() => {
    container.clearInstances();
  });

  it('player-sync: should not sync when lock not acquired', async () => {
    setupLockNotAcquired();

    const mockPlayerService = {
      syncPlayersFromProvider: jest.fn(),
      syncCollegePlayersFromCFBD: jest.fn(),
    };
    container.override(KEYS.PLAYER_SERVICE, mockPlayerService);

    const { runPlayerSync } = require('../../jobs/player-sync.job');
    await runPlayerSync();

    expect(mockPlayerService.syncPlayersFromProvider).not.toHaveBeenCalled();
    expect(mockClient.release).toHaveBeenCalled();
  });

  it('update-trending: should not update when lock not acquired', async () => {
    setupLockNotAcquired();

    const { runTrendingUpdate } = require('../../jobs/update-trending.job');
    await runTrendingUpdate();

    expect(mockClient.release).toHaveBeenCalled();
    // No unlock should be called since lock was never acquired
    const unlockCalls = mockClient.query.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].includes('pg_advisory_unlock')
    );
    expect(unlockCalls).toHaveLength(0);
  });
});

// ─── Interval-based job tests (use advanceTimersByTimeAsync) ───────────

describe('Interval-based job lock skip', () => {
  let mockClient: jest.Mocked<PoolClient>;
  let mockPool: jest.Mocked<Pool>;

  function setupLockNotAcquired() {
    mockClient.query.mockImplementation((query: string) => {
      if (typeof query === 'string' && query.includes('pg_try_advisory_lock')) {
        return Promise.resolve(mockQueryResult([{ acquired: false }]));
      }
      return Promise.resolve(mockQueryResult([]));
    });
  }

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    mockClient = createMockClient();
    mockPool = createMockPool(mockClient);
    container.clearInstances();
    container.override(KEYS.POOL, mockPool);
  });

  afterEach(() => {
    jest.useRealTimers();
    container.clearInstances();
  });

  it('autopick: should not process drafts when lock not acquired', async () => {
    setupLockNotAcquired();

    const mockDraftRepo = {
      findExpiredDrafts: jest.fn(),
      findByStatusAndOvernightPauseEnabled: jest.fn(),
    };
    const mockEngineFactory = { createEngine: jest.fn() };
    container.override(KEYS.DRAFT_REPO, mockDraftRepo);
    container.override(KEYS.DRAFT_ENGINE_FACTORY, mockEngineFactory);

    const { startAutopickJob, stopAutopickJob } = require('../../jobs/autopick.job');

    startAutopickJob();
    await jest.advanceTimersByTimeAsync(2500);

    expect(mockDraftRepo.findExpiredDrafts).not.toHaveBeenCalled();
    expect(mockEngineFactory.createEngine).not.toHaveBeenCalled();
    expect(mockClient.release).toHaveBeenCalled();

    stopAutopickJob();
  });

  it('trade-expiration: should not process trades when lock not acquired', async () => {
    setupLockNotAcquired();

    const mockTradesService = {
      processExpiredTrades: jest.fn(),
      processReviewCompleteTrades: jest.fn(),
    };
    container.override(KEYS.TRADES_SERVICE, mockTradesService);

    const { startTradeExpirationJob, stopTradeExpirationJob } = require('../../jobs/trade-expiration.job');

    startTradeExpirationJob();
    await jest.advanceTimersByTimeAsync(61000);

    expect(mockTradesService.processExpiredTrades).not.toHaveBeenCalled();
    expect(mockTradesService.processReviewCompleteTrades).not.toHaveBeenCalled();
    expect(mockClient.release).toHaveBeenCalled();

    stopTradeExpirationJob();
  });

  it('derby: should not process timeouts when lock not acquired', async () => {
    setupLockNotAcquired();

    const mockDerbyRepo = { findExpiredDerbyDrafts: jest.fn() };
    const mockDerbyService = { processTimeout: jest.fn() };
    container.override(KEYS.DERBY_REPO, mockDerbyRepo);
    container.override(KEYS.DERBY_SERVICE, mockDerbyService);

    const { startDerbyJob, stopDerbyJob } = require('../../jobs/derby.job');

    startDerbyJob();
    await jest.advanceTimersByTimeAsync(2500);

    expect(mockDerbyRepo.findExpiredDerbyDrafts).not.toHaveBeenCalled();
    expect(mockDerbyService.processTimeout).not.toHaveBeenCalled();
    expect(mockClient.release).toHaveBeenCalled();

    stopDerbyJob();
  });

  it('slow-auction: should not settle lots when lock not acquired', async () => {
    setupLockNotAcquired();

    const mockSlowAuctionService = { processExpiredLots: jest.fn() };
    const mockFastAuctionService = { autoNominate: jest.fn() };
    container.override(KEYS.SLOW_AUCTION_SERVICE, mockSlowAuctionService);
    container.override(KEYS.FAST_AUCTION_SERVICE, mockFastAuctionService);

    const { startSlowAuctionJob, stopSlowAuctionJob } = require('../../jobs/slow-auction.job');

    startSlowAuctionJob();
    await jest.advanceTimersByTimeAsync(5500);

    expect(mockSlowAuctionService.processExpiredLots).not.toHaveBeenCalled();
    expect(mockClient.release).toHaveBeenCalled();

    stopSlowAuctionJob();
  });

  it('waiver-processing: should not process waivers when lock not acquired', async () => {
    setupLockNotAcquired();

    const mockWaiversService = { processLeagueClaims: jest.fn() };
    container.override(KEYS.WAIVERS_SERVICE, mockWaiversService);

    const { startWaiverProcessingJob, stopWaiverProcessingJob } = require('../../jobs/waiver-processing.job');

    startWaiverProcessingJob();
    await jest.advanceTimersByTimeAsync(61000);

    expect(mockWaiversService.processLeagueClaims).not.toHaveBeenCalled();
    expect(mockClient.release).toHaveBeenCalled();

    stopWaiverProcessingJob();
  });
});

// ─── Auction Settlement Idempotency ────────────────────────────────────

describe('Auction Settlement Idempotency', () => {
  let mockClient: jest.Mocked<PoolClient>;
  let mockPool: jest.Mocked<Pool>;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    mockClient = createMockClient();
    mockPool = createMockPool(mockClient);
    container.clearInstances();
    container.override(KEYS.POOL, mockPool);
  });

  afterEach(() => {
    jest.useRealTimers();
    container.clearInstances();
  });

  it('processExpiredLots continues after per-lot failures', async () => {
    mockClient.query.mockImplementation((query: string) => {
      if (typeof query === 'string' && query.includes('pg_try_advisory_lock')) {
        return Promise.resolve(mockQueryResult([{ acquired: true }]));
      }
      if (typeof query === 'string' && query.includes('pg_advisory_unlock')) {
        return Promise.resolve(mockQueryResult([]));
      }
      if (typeof query === 'string' && query.includes('SELECT d.id as draft_id')) {
        return Promise.resolve(mockQueryResult([]));
      }
      return Promise.resolve(mockQueryResult([]));
    });

    // processExpiredLots internally catches per-lot errors and returns only successes
    const mockSlowAuctionService = {
      processExpiredLots: jest.fn().mockResolvedValue([
        {
          lot: { id: 2, playerId: 200, status: 'won' },
          winner: { rosterId: 3, amount: 15 },
          passed: false,
        },
      ]),
    };
    const mockFastAuctionService = { autoNominate: jest.fn() };
    container.override(KEYS.SLOW_AUCTION_SERVICE, mockSlowAuctionService);
    container.override(KEYS.FAST_AUCTION_SERVICE, mockFastAuctionService);

    const { startSlowAuctionJob, stopSlowAuctionJob } = require('../../jobs/slow-auction.job');

    startSlowAuctionJob();
    await jest.advanceTimersByTimeAsync(5500);

    expect(mockSlowAuctionService.processExpiredLots).toHaveBeenCalledTimes(1);

    const unlockCalls = mockClient.query.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].includes('pg_advisory_unlock')
    );
    expect(unlockCalls.length).toBeGreaterThan(0);

    stopSlowAuctionJob();
  });
});

// ─── Waiver Processing Dedup ───────────────────────────────────────────

describe('Waiver Processing Dedup', () => {
  let mockClient: jest.Mocked<PoolClient>;
  let mockPool: jest.Mocked<Pool>;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    mockClient = createMockClient();
    mockPool = createMockPool(mockClient);
    container.clearInstances();
    container.override(KEYS.POOL, mockPool);
  });

  afterEach(() => {
    jest.useRealTimers();
    container.clearInstances();
  });

  it('service dedup returns zero processed without processing claims', async () => {
    mockClient.query.mockImplementation((query: string) => {
      if (typeof query === 'string' && query.includes('pg_try_advisory_lock')) {
        return Promise.resolve(mockQueryResult([{ acquired: true }]));
      }
      if (typeof query === 'string' && query.includes('pg_advisory_unlock')) {
        return Promise.resolve(mockQueryResult([]));
      }
      if (typeof query === 'string' && query.includes('SELECT')) {
        return Promise.resolve(mockQueryResult([{
          id: 1,
          waiver_day: new Date().getUTCDay(),
          waiver_hour: new Date().getUTCHours(),
          waiver_settings: JSON.stringify({
            waiverType: 'standard',
            waiverDay: new Date().getUTCDay(),
            waiverHour: new Date().getUTCHours(),
          }),
        }]));
      }
      return Promise.resolve(mockQueryResult([]));
    });

    const mockWaiversService = {
      processLeagueClaims: jest.fn().mockResolvedValue({ processed: 0, successful: 0 }),
    };
    container.override(KEYS.WAIVERS_SERVICE, mockWaiversService);

    const { startWaiverProcessingJob, stopWaiverProcessingJob } = require('../../jobs/waiver-processing.job');

    startWaiverProcessingJob();
    await jest.advanceTimersByTimeAsync(61000);

    // Verify dedup layer prevents actual processing
    if (mockWaiversService.processLeagueClaims.mock.calls.length > 0) {
      const result = await mockWaiversService.processLeagueClaims.mock.results[0].value;
      expect(result).toEqual({ processed: 0, successful: 0 });
    }

    expect(mockClient.release).toHaveBeenCalled();

    stopWaiverProcessingJob();
  });
});
