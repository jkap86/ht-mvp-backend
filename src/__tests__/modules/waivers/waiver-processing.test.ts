import { Pool, PoolClient } from 'pg';
import {
  WaiverClaimsRepository,
  WaiverPriorityRepository,
  FaabBudgetRepository,
  WaiverWireRepository,
  WaiverClaimWithCurrentPriority,
} from '../../../modules/waivers/waivers.repository';
import { processLeagueClaims, ProcessWaiversContext } from '../../../modules/waivers/use-cases/process-waivers.use-case';
import { RosterPlayersRepository, RosterTransactionsRepository } from '../../../modules/rosters/rosters.repository';
import { RosterMutationService } from '../../../modules/rosters/roster-mutation.service';
import { LeagueRepository, RosterRepository } from '../../../modules/leagues/leagues.repository';
import { WaiverClaim, WaiverClaimStatus } from '../../../modules/waivers/waivers.model';

// Mock event bus
jest.mock('../../../shared/events', () => ({
  tryGetEventBus: jest.fn(() => ({
    publish: jest.fn(),
    beginTransaction: jest.fn(),
    startTransaction: jest.fn(),
    commitTransaction: jest.fn(),
    rollbackTransaction: jest.fn(),
  })),
  EventTypes: {
    WAIVER_CLAIM_SUCCESSFUL: 'waiver_claim_successful',
    WAIVER_CLAIM_FAILED: 'waiver_claim_failed',
    WAIVER_PRIORITY_UPDATED: 'waiver_priority_updated',
    WAIVER_BUDGET_UPDATED: 'waiver_budget_updated',
    TRADE_INVALIDATED: 'trade_invalidated',
    WAIVER_PROCESSED: 'waiver_processed',
  },
}));

// Mock logger
jest.mock('../../../config/logger.config', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

// Mock pool client factory
const createMockPoolClient = () => {
  const mockQuery = jest.fn().mockResolvedValue({ rows: [] });
  return {
    query: mockQuery,
    release: jest.fn(),
  } as unknown as jest.Mocked<PoolClient> & { query: jest.Mock };
};

// Mock pool factory
const createMockPool = (mockClient: ReturnType<typeof createMockPoolClient>) =>
  ({
    connect: jest.fn().mockResolvedValue(mockClient),
    query: jest.fn().mockResolvedValue({ rows: [] }),
  }) as unknown as jest.Mocked<Pool> & { query: jest.Mock };

describe('Waiver Processing', () => {
  let mockPool: jest.Mocked<Pool> & { query: jest.Mock };
  let mockClient: jest.Mocked<PoolClient> & { query: jest.Mock };
  let mockClaimsRepo: jest.Mocked<WaiverClaimsRepository>;
  let mockPriorityRepo: jest.Mocked<WaiverPriorityRepository>;
  let mockFaabRepo: jest.Mocked<FaabBudgetRepository>;
  let mockWaiverWireRepo: jest.Mocked<WaiverWireRepository>;
  let mockRosterPlayersRepo: jest.Mocked<RosterPlayersRepository>;
  let mockTransactionsRepo: jest.Mocked<RosterTransactionsRepository>;
  let mockLeagueRepo: jest.Mocked<LeagueRepository>;
  let mockRosterRepo: jest.Mocked<RosterRepository>;
  let mockRosterMutationService: jest.Mocked<RosterMutationService>;

  const createMockClaim = (
    id: number,
    rosterId: number,
    playerId: number,
    currentPriority: number | null,
    bidAmount = 0
  ): WaiverClaimWithCurrentPriority => ({
    id,
    leagueId: 1,
    rosterId,
    playerId,
    dropPlayerId: null,
    bidAmount,
    priorityAtClaim: currentPriority,
    currentPriority,
    status: 'pending' as WaiverClaimStatus,
    season: 2024,
    week: 1,
    processedAt: null,
    failureReason: null,
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-01T00:00:00Z'),
  });

  beforeEach(() => {
    jest.clearAllMocks();

    mockClient = createMockPoolClient();
    mockPool = createMockPool(mockClient);

    mockClaimsRepo = {
      getPendingByLeagueWithCurrentPriority: jest.fn(),
      updateStatus: jest.fn(),
      findByIdWithDetails: jest.fn(),
    } as unknown as jest.Mocked<WaiverClaimsRepository>;

    mockPriorityRepo = {
      rotatePriority: jest.fn(),
      getByLeague: jest.fn().mockResolvedValue([]),
    } as unknown as jest.Mocked<WaiverPriorityRepository>;

    mockFaabRepo = {
      getByRoster: jest.fn(),
      deductBudget: jest.fn(),
      getByLeague: jest.fn().mockResolvedValue([]),
    } as unknown as jest.Mocked<FaabBudgetRepository>;

    mockWaiverWireRepo = {
      removePlayer: jest.fn(),
    } as unknown as jest.Mocked<WaiverWireRepository>;

    mockRosterPlayersRepo = {
      findOwner: jest.fn().mockResolvedValue(null),
      findByRosterAndPlayer: jest.fn().mockResolvedValue(true),
      getPlayerCount: jest.fn().mockResolvedValue(10),
    } as unknown as jest.Mocked<RosterPlayersRepository>;

    mockTransactionsRepo = {
      create: jest.fn(),
    } as unknown as jest.Mocked<RosterTransactionsRepository>;

    mockLeagueRepo = {
      findById: jest.fn(),
    } as unknown as jest.Mocked<LeagueRepository>;

    mockRosterRepo = {
      findById: jest.fn().mockResolvedValue({ id: 1, userId: 'user1' }),
    } as unknown as jest.Mocked<RosterRepository>;

    mockRosterMutationService = {
      addPlayerToRoster: jest.fn(),
      removePlayerFromRoster: jest.fn(),
    } as unknown as jest.Mocked<RosterMutationService>;
  });

  describe('Priority rotation within same run', () => {
    it('should use rotated priority for subsequent claims in the same run', async () => {
      // Setup: League with rosters A(priority 1), B(priority 2), C(priority 3)
      // Claims:
      // - Roster A claims Player X
      // - Roster A claims Player Y
      // - Roster B claims Player Y
      //
      // Expected with rotation:
      // - A wins Player X (priority 1)
      // - A priority rotates to 3
      // - For Player Y: B has priority 1 (after shift), A has priority 3
      // - B wins Player Y

      const mockLeague = {
        id: 1,
        season: '2024',
        currentWeek: 1,
        settings: {
          waiver_type: 'standard',
          waiver_day: 2,
          waiver_hour: 3,
          roster_size: 15,
          current_week: 1,
        },
      };

      mockLeagueRepo.findById.mockResolvedValue(mockLeague as any);

      // Claims with current priorities at start of processing
      const claims: WaiverClaimWithCurrentPriority[] = [
        createMockClaim(1, 101, 1001, 1), // Roster A claims Player X, priority 1
        createMockClaim(2, 101, 1002, 1), // Roster A claims Player Y, priority 1
        createMockClaim(3, 102, 1002, 2), // Roster B claims Player Y, priority 2
      ];

      mockClaimsRepo.getPendingByLeagueWithCurrentPriority.mockResolvedValue(claims);

      // Track which claims get marked as successful/failed
      const statusUpdates: Array<{ id: number; status: string }> = [];
      mockClaimsRepo.updateStatus.mockImplementation(async (id, status) => {
        statusUpdates.push({ id, status });
        return { ...claims.find((c) => c.id === id)!, status } as WaiverClaim;
      });

      const ctx: ProcessWaiversContext = {
        db: mockPool,
        claimsRepo: mockClaimsRepo,
        priorityRepo: mockPriorityRepo,
        faabRepo: mockFaabRepo,
        waiverWireRepo: mockWaiverWireRepo,
        rosterPlayersRepo: mockRosterPlayersRepo,
        transactionsRepo: mockTransactionsRepo,
        leagueRepo: mockLeagueRepo,
        rosterRepo: mockRosterRepo,
        rosterMutationService: mockRosterMutationService,
      };

      const result = await processLeagueClaims(ctx, 1);

      // Verify results
      expect(result.processed).toBe(3);
      expect(result.successful).toBe(2);

      // Claim 1 (A claims X) should be successful
      expect(statusUpdates.find((u) => u.id === 1)?.status).toBe('successful');

      // Claim 3 (B claims Y) should be successful - B now has higher priority after A rotated
      expect(statusUpdates.find((u) => u.id === 3)?.status).toBe('successful');

      // Claim 2 (A claims Y) should be failed - A now has lowest priority after rotation
      expect(statusUpdates.find((u) => u.id === 2)?.status).toBe('failed');

      // Priority rotation should have been called twice (once for each successful claim)
      // First call: A wins Player X (rosterId 101)
      // Second call: B wins Player Y (rosterId 102)
      expect(mockPriorityRepo.rotatePriority).toHaveBeenCalledTimes(2);
      expect(mockPriorityRepo.rotatePriority).toHaveBeenNthCalledWith(1, 1, 2024, 101, expect.anything());
      expect(mockPriorityRepo.rotatePriority).toHaveBeenNthCalledWith(2, 1, 2024, 102, expect.anything());
    });

    it('should not affect FAAB mode where bid amount takes precedence', async () => {
      const mockLeague = {
        id: 1,
        season: '2024',
        currentWeek: 1,
        settings: {
          waiver_type: 'faab',
          waiver_day: 2,
          waiver_hour: 3,
          roster_size: 15,
          current_week: 1,
          faab_budget: 100,
        },
      };

      mockLeagueRepo.findById.mockResolvedValue(mockLeague as any);

      // Claims: A bids $50, B bids $60 for same player
      const claims: WaiverClaimWithCurrentPriority[] = [
        createMockClaim(1, 101, 1001, 1, 50), // A bids $50, priority 1
        createMockClaim(2, 102, 1001, 2, 60), // B bids $60, priority 2
      ];

      mockClaimsRepo.getPendingByLeagueWithCurrentPriority.mockResolvedValue(claims);

      // Mock FAAB budgets
      mockFaabRepo.getByRoster.mockImplementation(async (rosterId) => ({
        id: rosterId,
        leagueId: 1,
        rosterId,
        season: 2024,
        initialBudget: 100,
        remainingBudget: 100,
        updatedAt: new Date(),
      }));

      const statusUpdates: Array<{ id: number; status: string }> = [];
      mockClaimsRepo.updateStatus.mockImplementation(async (id, status) => {
        statusUpdates.push({ id, status });
        return { ...claims.find((c) => c.id === id)!, status } as WaiverClaim;
      });

      const ctx: ProcessWaiversContext = {
        db: mockPool,
        claimsRepo: mockClaimsRepo,
        priorityRepo: mockPriorityRepo,
        faabRepo: mockFaabRepo,
        waiverWireRepo: mockWaiverWireRepo,
        rosterPlayersRepo: mockRosterPlayersRepo,
        transactionsRepo: mockTransactionsRepo,
        leagueRepo: mockLeagueRepo,
        rosterRepo: mockRosterRepo,
        rosterMutationService: mockRosterMutationService,
      };

      await processLeagueClaims(ctx, 1);

      // B wins because higher bid, despite lower priority
      expect(statusUpdates.find((u) => u.id === 2)?.status).toBe('successful');
      expect(statusUpdates.find((u) => u.id === 1)?.status).toBe('failed');
    });
  });

  describe('Season/week scoping', () => {
    it('should only process claims for current week', async () => {
      const mockLeague = {
        id: 1,
        season: '2024',
        currentWeek: 2,
        settings: {
          waiver_type: 'standard',
          waiver_day: 2,
          waiver_hour: 3,
          roster_size: 15,
          current_week: 2,
        },
      };

      mockLeagueRepo.findById.mockResolvedValue(mockLeague as any);
      mockClaimsRepo.getPendingByLeagueWithCurrentPriority.mockResolvedValue([]);

      const ctx: ProcessWaiversContext = {
        db: mockPool,
        claimsRepo: mockClaimsRepo,
        priorityRepo: mockPriorityRepo,
        faabRepo: mockFaabRepo,
        waiverWireRepo: mockWaiverWireRepo,
        rosterPlayersRepo: mockRosterPlayersRepo,
        transactionsRepo: mockTransactionsRepo,
        leagueRepo: mockLeagueRepo,
        rosterRepo: mockRosterRepo,
        rosterMutationService: mockRosterMutationService,
      };

      await processLeagueClaims(ctx, 1);

      // Verify the repository was called with correct season and week
      expect(mockClaimsRepo.getPendingByLeagueWithCurrentPriority).toHaveBeenCalledWith(
        1, // leagueId
        2024, // season
        2, // week (current week, not 1)
        expect.anything()
      );
    });

    it('should skip processing if no current week set (pre-season)', async () => {
      const mockLeague = {
        id: 1,
        season: '2024',
        currentWeek: null,
        settings: {
          waiver_type: 'standard',
          waiver_day: 2,
          waiver_hour: 3,
          roster_size: 15,
        },
      };

      mockLeagueRepo.findById.mockResolvedValue(mockLeague as any);

      const ctx: ProcessWaiversContext = {
        db: mockPool,
        claimsRepo: mockClaimsRepo,
        priorityRepo: mockPriorityRepo,
        faabRepo: mockFaabRepo,
        waiverWireRepo: mockWaiverWireRepo,
        rosterPlayersRepo: mockRosterPlayersRepo,
        transactionsRepo: mockTransactionsRepo,
        leagueRepo: mockLeagueRepo,
        rosterRepo: mockRosterRepo,
        rosterMutationService: mockRosterMutationService,
      };

      const result = await processLeagueClaims(ctx, 1);

      expect(result.processed).toBe(0);
      expect(result.successful).toBe(0);
      expect(mockClaimsRepo.getPendingByLeagueWithCurrentPriority).not.toHaveBeenCalled();
    });
  });

  describe('Run tracking prevents duplicate processing', () => {
    it('should return 0 processed when no pending claims', async () => {
      const mockLeague = {
        id: 1,
        season: '2024',
        currentWeek: 1,
        settings: {
          waiver_type: 'standard',
          waiver_day: 2,
          waiver_hour: 3,
          roster_size: 15,
          current_week: 1,
        },
      };

      mockLeagueRepo.findById.mockResolvedValue(mockLeague as any);
      mockClaimsRepo.getPendingByLeagueWithCurrentPriority.mockResolvedValue([]);

      const ctx: ProcessWaiversContext = {
        db: mockPool,
        claimsRepo: mockClaimsRepo,
        priorityRepo: mockPriorityRepo,
        faabRepo: mockFaabRepo,
        waiverWireRepo: mockWaiverWireRepo,
        rosterPlayersRepo: mockRosterPlayersRepo,
        transactionsRepo: mockTransactionsRepo,
        leagueRepo: mockLeagueRepo,
        rosterRepo: mockRosterRepo,
        rosterMutationService: mockRosterMutationService,
      };

      const result = await processLeagueClaims(ctx, 1);

      expect(result.processed).toBe(0);
      expect(result.successful).toBe(0);
    });
  });
});

describe('Late Joiner Waiver Initialization', () => {
  describe('ensureRosterPriority', () => {
    it('should assign last place priority to late joiner', async () => {
      const mockQuery = jest.fn()
        .mockResolvedValueOnce({ rows: [{ max_priority: 2 }] })
        .mockResolvedValueOnce({ rows: [], rowCount: 1 });

      const mockPool = { query: mockQuery } as unknown as Pool;

      const repo = new WaiverPriorityRepository(mockPool);
      await repo.ensureRosterPriority(1, 103, 2024);

      // Should insert with priority 3 (max + 1)
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO waiver_priority'),
        [1, 103, 2024, 3]
      );
    });

    it('should be idempotent (ON CONFLICT DO NOTHING)', async () => {
      const mockQuery = jest.fn()
        .mockResolvedValueOnce({ rows: [{ max_priority: 2 }] })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const mockPool = { query: mockQuery } as unknown as Pool;

      const repo = new WaiverPriorityRepository(mockPool);

      await expect(repo.ensureRosterPriority(1, 103, 2024)).resolves.not.toThrow();
    });
  });

  describe('ensureRosterBudget', () => {
    it('should initialize FAAB budget for late joiner', async () => {
      const mockQuery = jest.fn().mockResolvedValueOnce({ rows: [], rowCount: 1 });

      const mockPool = { query: mockQuery } as unknown as Pool;

      const repo = new FaabBudgetRepository(mockPool);
      await repo.ensureRosterBudget(1, 103, 2024, 100);

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO faab_budgets'),
        [1, 103, 2024, 100]
      );
    });

    it('should be idempotent (ON CONFLICT DO NOTHING)', async () => {
      const mockQuery = jest.fn().mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const mockPool = { query: mockQuery } as unknown as Pool;

      const repo = new FaabBudgetRepository(mockPool);

      await expect(repo.ensureRosterBudget(1, 103, 2024, 100)).resolves.not.toThrow();
    });
  });
});
