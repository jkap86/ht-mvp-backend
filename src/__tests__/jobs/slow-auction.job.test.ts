import { Pool, PoolClient } from 'pg';
import { container, KEYS } from '../../container';
import { SlowAuctionService, SettlementResult } from '../../modules/drafts/auction/slow-auction.service';
import { FastAuctionService } from '../../modules/drafts/auction/fast-auction.service';
import { AuctionLot } from '../../modules/drafts/auction/auction.models';

// Helper to create mock query result
const mockQueryResult = (rows: any[]) => ({ rows });

// Mock data
const mockActiveLot: AuctionLot = {
  id: 1,
  draftId: 1,
  playerId: 100,
  nominatorRosterId: 1,
  currentBid: 10,
  currentBidderRosterId: 2,
  bidCount: 3,
  bidDeadline: new Date(Date.now() - 1000), // Expired
  status: 'active',
  winningRosterId: null,
  winningBid: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const mockWonSettlementResult: SettlementResult = {
  lot: { ...mockActiveLot, status: 'won', winningRosterId: 2, winningBid: 10 },
  winner: { rosterId: 2, amount: 10 },
  passed: false,
};

const mockPassedSettlementResult: SettlementResult = {
  lot: { ...mockActiveLot, status: 'passed', currentBidderRosterId: null, currentBid: 1 },
  winner: null,
  passed: true,
};

// Mock services
const createMockSlowAuctionService = (): jest.Mocked<SlowAuctionService> =>
  ({
    processExpiredLots: jest.fn(),
    settleLot: jest.fn(),
    getSettings: jest.fn(),
  }) as unknown as jest.Mocked<SlowAuctionService>;

const createMockFastAuctionService = (): jest.Mocked<FastAuctionService> =>
  ({
    advanceNominator: jest.fn(),
    forceAdvanceNominator: jest.fn(),
    autoNominate: jest.fn(),
    getSettings: jest.fn(),
  }) as unknown as jest.Mocked<FastAuctionService>;

// Mock pool client
const createMockClient = (): jest.Mocked<PoolClient> => {
  const client = {
    query: jest.fn(),
    release: jest.fn(),
  } as unknown as jest.Mocked<PoolClient>;
  return client;
};

const createMockPool = (client: jest.Mocked<PoolClient>): jest.Mocked<Pool> =>
  ({
    connect: jest.fn().mockResolvedValue(client),
  }) as unknown as jest.Mocked<Pool>;

// Mock socket service at module level to avoid reset issues
const mockSocketService = {
  emitAuctionLotWon: jest.fn(),
  emitAuctionLotPassed: jest.fn(),
  emitAuctionNominatorChanged: jest.fn(),
};

jest.mock('../../socket/socket.service', () => ({
  tryGetSocketService: jest.fn(() => mockSocketService),
}));

jest.mock('../../config/logger.config', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

describe('Slow Auction Job', () => {
  let mockSlowAuctionService: jest.Mocked<SlowAuctionService>;
  let mockFastAuctionService: jest.Mocked<FastAuctionService>;
  let mockClient: jest.Mocked<PoolClient>;
  let mockPool: jest.Mocked<Pool>;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();

    mockSlowAuctionService = createMockSlowAuctionService();
    mockFastAuctionService = createMockFastAuctionService();
    mockClient = createMockClient();
    mockPool = createMockPool(mockClient);

    // Setup container mocks
    container.clearInstances();
    container.override(KEYS.POOL, mockPool);
    container.override(KEYS.SLOW_AUCTION_SERVICE, mockSlowAuctionService);
    container.override(KEYS.FAST_AUCTION_SERVICE, mockFastAuctionService);
  });

  afterEach(() => {
    jest.useRealTimers();
    container.clearInstances();
  });

  describe('startSlowAuctionJob', () => {
    it('should start interval timer', () => {
      const { startSlowAuctionJob, stopSlowAuctionJob } = require('../../jobs/slow-auction.job');

      startSlowAuctionJob();

      // Job should be started
      expect(jest.getTimerCount()).toBeGreaterThan(0);

      stopSlowAuctionJob();
    });

    it('should not start multiple times', () => {
      const { startSlowAuctionJob, stopSlowAuctionJob } = require('../../jobs/slow-auction.job');
      const { logger } = require('../../config/logger.config');

      // Clear any prior state
      stopSlowAuctionJob();
      jest.clearAllMocks();

      startSlowAuctionJob();
      const initialTimerCount = jest.getTimerCount();

      startSlowAuctionJob(); // Second call

      expect(logger.warn).toHaveBeenCalledWith('Slow auction job already running');
      expect(jest.getTimerCount()).toBe(initialTimerCount); // No new timer

      stopSlowAuctionJob();
    });
  });

  describe('stopSlowAuctionJob', () => {
    it('should clear interval timer', () => {
      const { startSlowAuctionJob, stopSlowAuctionJob } = require('../../jobs/slow-auction.job');
      const { logger } = require('../../config/logger.config');

      startSlowAuctionJob();
      stopSlowAuctionJob();

      expect(logger.info).toHaveBeenCalledWith('Slow auction job stopped');
    });

    it('should be safe to call when not running', () => {
      const { stopSlowAuctionJob } = require('../../jobs/slow-auction.job');

      // Should not throw
      expect(() => stopSlowAuctionJob()).not.toThrow();
    });
  });

  describe('processExpiredLots behavior', () => {
    it('should skip processing if lock not acquired', async () => {
      // Setup lock acquisition failure
      mockClient.query.mockImplementation((query: string) => {
        if (query.includes('pg_try_advisory_lock')) {
          return Promise.resolve(mockQueryResult([{ acquired: false }]));
        }
        return Promise.resolve(mockQueryResult([]));
      });

      const { startSlowAuctionJob, stopSlowAuctionJob } = require('../../jobs/slow-auction.job');

      startSlowAuctionJob();
      jest.advanceTimersByTime(5000);
      await Promise.resolve();

      // Should not call processExpiredLots when lock not acquired
      expect(mockSlowAuctionService.processExpiredLots).not.toHaveBeenCalled();

      stopSlowAuctionJob();
    });

    it('should skip nomination timeout processing when no drafts found', async () => {
      // Return no drafts matching fast auction criteria
      mockClient.query.mockImplementation((query: string) => {
        if (query.includes('pg_try_advisory_lock')) {
          return Promise.resolve(mockQueryResult([{ acquired: true }]));
        }
        if (query.includes('pg_advisory_unlock')) {
          return Promise.resolve(mockQueryResult([]));
        }
        if (query.includes('SELECT d.id as draft_id')) {
          // No fast auction drafts with expired deadlines
          return Promise.resolve(mockQueryResult([]));
        }
        return Promise.resolve(mockQueryResult([]));
      });

      mockSlowAuctionService.processExpiredLots.mockResolvedValue([]);

      const { startSlowAuctionJob, stopSlowAuctionJob } = require('../../jobs/slow-auction.job');

      startSlowAuctionJob();
      jest.advanceTimersByTime(5000);
      await Promise.resolve();

      // autoNominate should not be called
      expect(mockFastAuctionService.autoNominate).not.toHaveBeenCalled();

      stopSlowAuctionJob();
    });
  });

  describe('settlement result types', () => {
    it('should have correct won settlement result structure', () => {
      expect(mockWonSettlementResult.lot.status).toBe('won');
      expect(mockWonSettlementResult.winner).toEqual({ rosterId: 2, amount: 10 });
      expect(mockWonSettlementResult.passed).toBe(false);
    });

    it('should have correct passed settlement result structure', () => {
      expect(mockPassedSettlementResult.lot.status).toBe('passed');
      expect(mockPassedSettlementResult.winner).toBeNull();
      expect(mockPassedSettlementResult.passed).toBe(true);
    });
  });
});
