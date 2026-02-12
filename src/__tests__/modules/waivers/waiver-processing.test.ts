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
import { ConflictException } from '../../../utils/exceptions';

// Mock event bus
jest.mock('../../../shared/events', () => ({
  tryGetEventBus: jest.fn(() => ({
    publish: jest.fn(),
    beginTransaction: jest.fn(),
    startTransaction: jest.fn(),
    commitTransaction: jest.fn(),
    rollbackTransaction: jest.fn(),
    runInTransaction: jest.fn((fn: () => Promise<unknown>) => fn()),
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
    bidAmount = 0,
    claimOrder = 1
  ): WaiverClaimWithCurrentPriority => ({
    id,
    leagueId: 1,
    rosterId,
    playerId,
    dropPlayerId: null,
    bidAmount,
    priorityAtClaim: currentPriority,
    claimOrder,
    currentPriority,
    status: 'pending' as WaiverClaimStatus,
    season: 2024,
    week: 1,
    processedAt: null,
    failureReason: null,
    processingRunId: null,
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
      getPlayerIdsByRoster: jest.fn().mockResolvedValue([]),
      getOwnedPlayerIdsByLeague: jest.fn().mockResolvedValue(new Set<number>()),
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
    it('should rotate priority after wins within round-based processing', async () => {
      // Test priority rotation with round-based processing
      // When rosters compete for the same player in the same round, priority matters

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

      // Both rosters have their #1 claim for the SAME player
      // This creates a conflict in round 1 where priority determines winner
      const claims: WaiverClaimWithCurrentPriority[] = [
        createMockClaim(1, 101, 1001, 1, 0, 1), // Roster A: #1 for Player X, priority 1
        createMockClaim(2, 102, 1001, 2, 0, 1), // Roster B: #1 for Player X, priority 2
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

      // Verify results - 2 processed, 1 successful (A wins due to higher priority)
      expect(result.processed).toBe(2);
      expect(result.successful).toBe(1);

      // Claim 1 (A claims X) should be successful - A has priority 1
      expect(statusUpdates.find((u) => u.id === 1)?.status).toBe('successful');

      // Claim 2 (B claims X) should be failed - B has priority 2, loses to A
      expect(statusUpdates.find((u) => u.id === 2)?.status).toBe('failed');

      // Priority rotation should have been called once (for A's win)
      expect(mockPriorityRepo.rotatePriority).toHaveBeenCalledTimes(1);
      expect(mockPriorityRepo.rotatePriority).toHaveBeenCalledWith(1, 2024, 101, expect.anything());
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

describe('Round-based Processing', () => {
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
    bidAmount = 0,
    claimOrder = 1
  ): WaiverClaimWithCurrentPriority => ({
    id,
    leagueId: 1,
    rosterId,
    playerId,
    dropPlayerId: null,
    bidAmount,
    priorityAtClaim: currentPriority,
    claimOrder,
    currentPriority,
    status: 'pending' as WaiverClaimStatus,
    season: 2024,
    week: 1,
    processedAt: null,
    failureReason: null,
    processingRunId: null,
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-01T00:00:00Z'),
  });

  beforeEach(() => {
    jest.clearAllMocks();

    const mockQuery = jest.fn().mockResolvedValue({ rows: [] });
    mockClient = {
      query: mockQuery,
      release: jest.fn(),
    } as unknown as jest.Mocked<PoolClient> & { query: jest.Mock };

    mockPool = {
      connect: jest.fn().mockResolvedValue(mockClient),
      query: jest.fn().mockResolvedValue({ rows: [] }),
    } as unknown as jest.Mocked<Pool> & { query: jest.Mock };

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
      getPlayerIdsByRoster: jest.fn().mockResolvedValue([]),
      getOwnedPlayerIdsByLeague: jest.fn().mockResolvedValue(new Set<number>()),
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

  it('should process claims in claim_order sequence per roster with same-round conflicts', async () => {
    // Test that when multiple rosters claim the same player in the same round,
    // priority determines the winner

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

    // Both rosters have #1 claims for the same player (conflict in round 1)
    const claims: WaiverClaimWithCurrentPriority[] = [
      createMockClaim(1, 101, 1001, 1, 0, 1), // Roster A: #1 for Player X, priority 1
      createMockClaim(2, 102, 1001, 2, 0, 1), // Roster B: #1 for Player X, priority 2
      createMockClaim(3, 101, 1002, 1, 0, 2), // Roster A: #2 for Player Y
    ];

    mockClaimsRepo.getPendingByLeagueWithCurrentPriority.mockResolvedValue(claims);

    // Track status updates
    const statusUpdates: Array<{ id: number; status: string; reason?: string }> = [];
    mockClaimsRepo.updateStatus.mockImplementation(async (id, status, reason) => {
      statusUpdates.push({ id, status, reason });
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

    expect(result.processed).toBe(3);
    expect(result.successful).toBe(2);

    // Round 1: A wins Player X (higher priority), B loses
    expect(statusUpdates.find((u) => u.id === 1)?.status).toBe('successful');
    expect(statusUpdates.find((u) => u.id === 2)?.status).toBe('failed');

    // Round 2: A wins Player Y (no competition)
    expect(statusUpdates.find((u) => u.id === 3)?.status).toBe('successful');
  });

  it('should use updated FAAB budget for later claims from same roster', async () => {
    // Setup:
    // - Roster A has $50 budget
    // - Claim #1: $30 for Player X
    // - Claim #2: $25 for Player Y
    //
    // Expected:
    // - #1 wins, budget = $20
    // - #2 fails: "Insufficient FAAB budget"

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

    const claims: WaiverClaimWithCurrentPriority[] = [
      createMockClaim(1, 101, 1001, 1, 30, 1), // Claim #1: $30 for Player X
      createMockClaim(2, 101, 1002, 1, 25, 2), // Claim #2: $25 for Player Y
    ];

    mockClaimsRepo.getPendingByLeagueWithCurrentPriority.mockResolvedValue(claims);

    // Mock FAAB budget - $50 remaining
    mockFaabRepo.getByRoster.mockResolvedValue({
      id: 1,
      leagueId: 1,
      rosterId: 101,
      season: 2024,
      initialBudget: 100,
      remainingBudget: 50,
      updatedAt: new Date(),
    });

    const statusUpdates: Array<{ id: number; status: string; reason?: string }> = [];
    mockClaimsRepo.updateStatus.mockImplementation(async (id, status, reason) => {
      statusUpdates.push({ id, status, reason });
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

    expect(result.processed).toBe(2);
    expect(result.successful).toBe(1);

    // Claim #1 wins
    expect(statusUpdates.find((u) => u.id === 1)?.status).toBe('successful');

    // Claim #2 fails due to insufficient budget ($50 - $30 = $20 < $25)
    const claim2Update = statusUpdates.find((u) => u.id === 2);
    expect(claim2Update?.status).toBe('invalid');
    expect(claim2Update?.reason).toContain('Insufficient FAAB budget');
  });

  it('should only consider active claims (next in order) for conflicts', async () => {
    // Setup:
    // - Roster A: #1 Player X, #2 Player Z
    // - Roster B: #1 Player Y, #2 Player X
    //
    // Expected:
    // - Round 1: A wins X (no conflict), B wins Y (no conflict)
    // - Round 2: A wins Z (no conflict), B tries X but player already owned by A -> invalid
    //
    // Key insight: In round 1, both rosters' #1 claims are for different players
    // so there's no conflict. B's #2 for X only becomes active in round 2,
    // by which time A already owns X. With global ownership tracking, this is now caught.

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

    const claims: WaiverClaimWithCurrentPriority[] = [
      createMockClaim(1, 101, 1001, 1, 0, 1), // A: #1 Player X
      createMockClaim(2, 101, 1003, 1, 0, 2), // A: #2 Player Z
      createMockClaim(3, 102, 1002, 2, 0, 1), // B: #1 Player Y
      createMockClaim(4, 102, 1001, 2, 0, 2), // B: #2 Player X (same as A's #1)
    ];

    mockClaimsRepo.getPendingByLeagueWithCurrentPriority.mockResolvedValue(claims);

    // Track which player IDs are owned by which roster
    const ownedByRoster: Map<number, Set<number>> = new Map([
      [101, new Set<number>()],
      [102, new Set<number>()],
    ]);

    // Mock getPlayerIdsByRoster to return current ownership
    mockRosterPlayersRepo.getPlayerIdsByRoster.mockImplementation(async (rosterId) => {
      return Array.from(ownedByRoster.get(rosterId) || []);
    });

    const statusUpdates: Array<{ id: number; status: string; reason?: string }> = [];
    mockClaimsRepo.updateStatus.mockImplementation(async (id, status, reason) => {
      statusUpdates.push({ id, status, reason });
      return { ...claims.find((c) => c.id === id)!, status } as WaiverClaim;
    });

    // When a player is added, track it per-roster
    mockRosterMutationService.addPlayerToRoster.mockImplementation(async ({ rosterId, playerId }) => {
      ownedByRoster.get(rosterId)?.add(playerId);
      return { rosterId, playerId } as any;
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

    // All 4 claims are processed
    expect(result.processed).toBe(4);

    // Round 1: A wins X, B wins Y (both succeed, no conflicts)
    expect(statusUpdates.find((u) => u.id === 1)?.status).toBe('successful');
    expect(statusUpdates.find((u) => u.id === 3)?.status).toBe('successful');

    // Round 2: A wins Z (no conflict)
    expect(statusUpdates.find((u) => u.id === 2)?.status).toBe('successful');

    // Round 2: B's #2 for X - NOW CORRECTLY marked as invalid because
    // global ownership tracking shows Player X is already owned by A
    const claim4Update = statusUpdates.find((u) => u.id === 4);
    expect(claim4Update?.status).toBe('invalid');
    expect(claim4Update?.reason).toContain('already owned');

    // Only 3 successful claims now
    expect(result.successful).toBe(3);
  });
});

describe('Stale Claim Handling (Hardening)', () => {
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
    bidAmount = 0,
    claimOrder = 1
  ): WaiverClaimWithCurrentPriority => ({
    id,
    leagueId: 1,
    rosterId,
    playerId,
    dropPlayerId: null,
    bidAmount,
    priorityAtClaim: currentPriority,
    claimOrder,
    currentPriority,
    status: 'pending' as WaiverClaimStatus,
    season: 2024,
    week: 1,
    processedAt: null,
    failureReason: null,
    processingRunId: null,
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-01T00:00:00Z'),
  });

  beforeEach(() => {
    jest.clearAllMocks();

    const mockQuery = jest.fn().mockResolvedValue({ rows: [] });
    mockClient = {
      query: mockQuery,
      release: jest.fn(),
    } as unknown as jest.Mocked<PoolClient> & { query: jest.Mock };

    mockPool = {
      connect: jest.fn().mockResolvedValue(mockClient),
      query: jest.fn().mockResolvedValue({ rows: [] }),
    } as unknown as jest.Mocked<Pool> & { query: jest.Mock };

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
      getPlayerIdsByRoster: jest.fn().mockResolvedValue([]),
      getOwnedPlayerIdsByLeague: jest.fn().mockResolvedValue(new Set<number>()),
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

  it('should handle addPlayerToRoster ConflictException gracefully', async () => {
    // Setup:
    // - Player X is owned by a roster not participating in waivers
    // - Roster A has pending claim for Player X
    // - addPlayerToRoster throws ConflictException
    //
    // Expected:
    // - Claim marked as invalid, not crash the transaction
    // - Processing continues

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

    const claims: WaiverClaimWithCurrentPriority[] = [
      createMockClaim(1, 101, 1001, 1, 0, 1), // A claims Player X
      createMockClaim(2, 101, 1002, 1, 0, 2), // A claims Player Y (should still succeed)
    ];

    mockClaimsRepo.getPendingByLeagueWithCurrentPriority.mockResolvedValue(claims);

    // Mock addPlayerToRoster to throw ConflictException for Player X
    mockRosterMutationService.addPlayerToRoster.mockImplementation(async ({ playerId }) => {
      if (playerId === 1001) {
        throw new ConflictException('Player is already on a roster');
      }
      return { rosterId: 101, playerId } as any;
    });

    const statusUpdates: Array<{ id: number; status: string; reason?: string }> = [];
    mockClaimsRepo.updateStatus.mockImplementation(async (id, status, reason) => {
      statusUpdates.push({ id, status, reason });
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

    // Should NOT throw - gracefully handles the conflict
    const result = await processLeagueClaims(ctx, 1);

    // Both claims processed, only 1 successful
    expect(result.processed).toBe(2);
    expect(result.successful).toBe(1);

    // Claim 1 (Player X) should be invalid
    const claim1Update = statusUpdates.find((u) => u.id === 1);
    expect(claim1Update?.status).toBe('invalid');
    expect(claim1Update?.reason).toContain('already owned');

    // Claim 2 (Player Y) should be successful
    expect(statusUpdates.find((u) => u.id === 2)?.status).toBe('successful');
  });

  it('should try next claimant if top claim fails due to ownership conflict', async () => {
    // Setup:
    // - Two rosters claim same player
    // - First winner candidate (A) gets ConflictException during execution
    //   (player is owned by a non-participating roster)
    // - Second candidate (B) should be tried next and succeed
    //
    // This tests the find-first-executable fallthrough behavior

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

    // Both rosters claim same player - A has higher priority but will hit conflict
    const claims: WaiverClaimWithCurrentPriority[] = [
      createMockClaim(1, 101, 1001, 1, 0, 1), // A claims Player X, priority 1
      createMockClaim(2, 102, 1001, 2, 0, 1), // B claims Player X, priority 2
    ];

    mockClaimsRepo.getPendingByLeagueWithCurrentPriority.mockResolvedValue(claims);

    // First attempt (Roster A) fails because player is owned by a non-participating roster
    // Second attempt (Roster B) should succeed because we now fallthrough to try next candidate
    let firstAttempt = true;
    mockRosterMutationService.addPlayerToRoster.mockImplementation(async ({ rosterId }) => {
      if (firstAttempt && rosterId === 101) {
        firstAttempt = false;
        throw new ConflictException('Player is already on a roster');
      }
      return { rosterId, playerId: 1001 } as any;
    });

    const statusUpdates: Array<{ id: number; status: string; reason?: string }> = [];
    mockClaimsRepo.updateStatus.mockImplementation(async (id, status, reason) => {
      statusUpdates.push({ id, status, reason });
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

    expect(result.processed).toBe(2);
    expect(result.successful).toBe(1); // B should succeed!

    // A's claim is invalid (ConflictException caught)
    const claim1Update = statusUpdates.find((u) => u.id === 1);
    expect(claim1Update?.status).toBe('invalid');
    expect(claim1Update?.reason).toContain('already owned');

    // B's claim should now SUCCEED because we fallthrough to try the next candidate
    const claim2Update = statusUpdates.find((u) => u.id === 2);
    expect(claim2Update?.status).toBe('successful');
  });

  it('should mark remaining claims as no eligible claimers when all candidates fail', async () => {
    // Setup:
    // - Two rosters claim same player
    // - BOTH candidates get ConflictException during execution
    //   (player is owned by a non-participating roster)
    // - All claims should be marked invalid, none successful

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

    const claims: WaiverClaimWithCurrentPriority[] = [
      createMockClaim(1, 101, 1001, 1, 0, 1), // A claims Player X, priority 1
      createMockClaim(2, 102, 1001, 2, 0, 1), // B claims Player X, priority 2
    ];

    mockClaimsRepo.getPendingByLeagueWithCurrentPriority.mockResolvedValue(claims);

    // ALL attempts fail because player is owned externally
    mockRosterMutationService.addPlayerToRoster.mockRejectedValue(
      new ConflictException('Player is already on a roster')
    );

    const statusUpdates: Array<{ id: number; status: string; reason?: string }> = [];
    mockClaimsRepo.updateStatus.mockImplementation(async (id, status, reason) => {
      statusUpdates.push({ id, status, reason });
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

    expect(result.processed).toBe(2);
    expect(result.successful).toBe(0);

    // Both should be invalid due to ownership conflicts
    const claim1Update = statusUpdates.find((u) => u.id === 1);
    expect(claim1Update?.status).toBe('invalid');
    expect(claim1Update?.reason).toContain('already owned');

    const claim2Update = statusUpdates.find((u) => u.id === 2);
    expect(claim2Update?.status).toBe('invalid');
    expect(claim2Update?.reason).toContain('already owned');
  });

  it('should track player as globally owned after ConflictException', async () => {
    // Setup:
    // - Roster A: #1 Player X (will hit conflict), #2 Player Y
    // - Roster B: #1 Player Y (should fail because Y gets claimed by A in round 2)
    //
    // Actually, in this scenario:
    // - Round 1: A tries X, hits conflict, X added to global set
    // - Round 1: No other claims for X in this round
    // - Round 2: A claims Y successfully
    // - Round 2: B also claims Y -> conflict in same round, A wins by priority

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

    const claims: WaiverClaimWithCurrentPriority[] = [
      createMockClaim(1, 101, 1001, 1, 0, 1), // A: #1 Player X (will fail)
      createMockClaim(2, 101, 1002, 1, 0, 2), // A: #2 Player Y
      createMockClaim(3, 102, 1002, 2, 0, 1), // B: #1 Player Y (competes with A in round 2... wait no)
    ];

    // Actually B's claim is for round 1, not round 2. Let me adjust:
    // Round 1: A's #1 (X) vs B's #1 (Y) - no conflict, both processed
    // A's X fails with conflict, B's Y succeeds
    // Round 2: A's #2 (Y) - but Y is now owned by B -> invalid

    mockClaimsRepo.getPendingByLeagueWithCurrentPriority.mockResolvedValue(claims);

    mockRosterMutationService.addPlayerToRoster.mockImplementation(async ({ rosterId, playerId }) => {
      if (playerId === 1001) {
        throw new ConflictException('Player is already on a roster');
      }
      return { rosterId, playerId } as any;
    });

    const statusUpdates: Array<{ id: number; status: string; reason?: string }> = [];
    mockClaimsRepo.updateStatus.mockImplementation(async (id, status, reason) => {
      statusUpdates.push({ id, status, reason });
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

    expect(result.processed).toBe(3);

    // Claim 1 (A's X) should be invalid (ConflictException)
    expect(statusUpdates.find((u) => u.id === 1)?.status).toBe('invalid');

    // Claim 3 (B's Y) should be successful
    expect(statusUpdates.find((u) => u.id === 3)?.status).toBe('successful');

    // Claim 2 (A's Y in round 2) should be invalid because Y is now globally owned
    const claim2Update = statusUpdates.find((u) => u.id === 2);
    expect(claim2Update?.status).toBe('invalid');
    expect(claim2Update?.reason).toContain('already owned');

    expect(result.successful).toBe(1);
  });
});

describe('Full League Ownership Preload', () => {
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
    bidAmount = 0,
    claimOrder = 1
  ): WaiverClaimWithCurrentPriority => ({
    id,
    leagueId: 1,
    rosterId,
    playerId,
    dropPlayerId: null,
    bidAmount,
    priorityAtClaim: currentPriority,
    claimOrder,
    currentPriority,
    status: 'pending' as WaiverClaimStatus,
    season: 2024,
    week: 1,
    processedAt: null,
    failureReason: null,
    processingRunId: null,
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-01T00:00:00Z'),
  });

  beforeEach(() => {
    jest.clearAllMocks();

    const mockQuery = jest.fn().mockResolvedValue({ rows: [] });
    mockClient = {
      query: mockQuery,
      release: jest.fn(),
    } as unknown as jest.Mocked<PoolClient> & { query: jest.Mock };

    mockPool = {
      connect: jest.fn().mockResolvedValue(mockClient),
      query: jest.fn().mockResolvedValue({ rows: [] }),
    } as unknown as jest.Mocked<Pool> & { query: jest.Mock };

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
      addPlayer: jest.fn(),
    } as unknown as jest.Mocked<WaiverWireRepository>;

    mockRosterPlayersRepo = {
      findOwner: jest.fn().mockResolvedValue(null),
      findByRosterAndPlayer: jest.fn().mockResolvedValue(true),
      getPlayerCount: jest.fn().mockResolvedValue(10),
      getPlayerIdsByRoster: jest.fn().mockResolvedValue([]),
      getOwnedPlayerIdsByLeague: jest.fn().mockResolvedValue(new Set<number>()),
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

  it('should reject claim for player owned by roster with no claims (no executeClaim needed)', async () => {
    // Setup:
    // - Roster A (has claims): claims Player X
    // - Roster C (NO claims): already owns Player X
    //
    // Expected:
    // - Player X ownership detected via preloaded league ownership
    // - Claim marked invalid with "Player already owned" BEFORE executeClaim
    // - addPlayerToRoster should NOT be called (no ConflictException needed)

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

    const claims: WaiverClaimWithCurrentPriority[] = [
      createMockClaim(1, 101, 1001, 1, 0, 1), // Roster A claims Player X
    ];

    mockClaimsRepo.getPendingByLeagueWithCurrentPriority.mockResolvedValue(claims);

    // Mock: Player X (1001) is owned by Roster C (103) which has NO claims
    // getPlayerIdsByRoster for Roster A returns empty (A has no players)
    mockRosterPlayersRepo.getPlayerIdsByRoster.mockResolvedValue([]);

    // NEW: Mock getOwnedPlayerIdsByLeague to return Player X as owned
    mockRosterPlayersRepo.getOwnedPlayerIdsByLeague.mockResolvedValue(
      new Set([1001]) // Player X is owned somewhere in the league
    );

    const statusUpdates: Array<{ id: number; status: string; reason?: string }> = [];
    mockClaimsRepo.updateStatus.mockImplementation(async (id, status, reason) => {
      statusUpdates.push({ id, status, reason });
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

    // Claim should be invalid
    expect(result.processed).toBe(1);
    expect(result.successful).toBe(0);

    const claim1Update = statusUpdates.find((u) => u.id === 1);
    expect(claim1Update?.status).toBe('invalid');
    expect(claim1Update?.reason).toContain('already owned');

    // KEY ASSERTION: addPlayerToRoster should NOT have been called
    // because we detected ownership via preload, not via ConflictException
    expect(mockRosterMutationService.addPlayerToRoster).not.toHaveBeenCalled();
  });

  it('should update ownedPlayerIds when claim with drop succeeds', async () => {
    // Setup:
    // - Roster A claims Player X and drops Player Y
    // - Player Y is currently owned by Roster A
    // - Roster B claims Player Y in the next round
    //
    // Expected:
    // - Roster A's claim succeeds, Y removed from ownedPlayerIds
    // - Roster B's claim for Y should succeed (Y is now available)

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

    const claims: WaiverClaimWithCurrentPriority[] = [
      { ...createMockClaim(1, 101, 1001, 1, 0, 1), dropPlayerId: 1002 }, // A: claim X, drop Y
      createMockClaim(2, 102, 1002, 2, 0, 1), // B: claim Y (dropped by A)
    ];

    mockClaimsRepo.getPendingByLeagueWithCurrentPriority.mockResolvedValue(claims);

    // Initially: Roster A owns Player Y (1002)
    mockRosterPlayersRepo.getPlayerIdsByRoster.mockImplementation(async (rosterId) => {
      if (rosterId === 101) return [1002]; // A owns Y
      return [];
    });

    // League-wide ownership: Y is owned
    mockRosterPlayersRepo.getOwnedPlayerIdsByLeague.mockResolvedValue(
      new Set([1002]) // Y is owned at start
    );

    // findByRosterAndPlayer returns true for A's drop of Y
    mockRosterPlayersRepo.findByRosterAndPlayer.mockResolvedValue({ rosterId: 101, playerId: 1002 } as any);

    const statusUpdates: Array<{ id: number; status: string; reason?: string }> = [];
    mockClaimsRepo.updateStatus.mockImplementation(async (id, status, reason) => {
      statusUpdates.push({ id, status, reason });
      return { ...claims.find((c) => c.id === id)!, status } as WaiverClaim;
    });

    mockRosterMutationService.addPlayerToRoster.mockResolvedValue({ rosterId: 101, playerId: 1001 } as any);
    mockRosterMutationService.removePlayerFromRoster.mockResolvedValue(undefined);

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

    // Both claims should be processed
    expect(result.processed).toBe(2);
    // Both should succeed: A gets X (drops Y), B gets Y
    expect(result.successful).toBe(2);

    expect(statusUpdates.find((u) => u.id === 1)?.status).toBe('successful');
    expect(statusUpdates.find((u) => u.id === 2)?.status).toBe('successful');
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
