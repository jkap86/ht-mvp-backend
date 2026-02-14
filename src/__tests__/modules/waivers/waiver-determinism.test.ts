import { Pool, PoolClient } from 'pg';
import {
  processLeagueClaims,
  compareClaims,
  ProcessWaiversContext,
  RosterProcessingState,
} from '../../../modules/waivers/use-cases/process-waivers.use-case';
import {
  WaiverClaimWithCurrentPriority,
  WaiverClaimsRepository,
  FaabBudgetRepository,
  WaiverPriorityRepository,
  WaiverWireRepository,
} from '../../../modules/waivers/waivers.repository';
import {
  RosterPlayersRepository,
  RosterTransactionsRepository,
} from '../../../modules/rosters/rosters.repository';
import { LeagueRepository, RosterRepository } from '../../../modules/leagues/leagues.repository';
import { WaiverClaimStatus } from '../../../modules/waivers/waivers.model';

// Mock dependencies
jest.mock('../../../shared/events', () => ({
  tryGetEventBus: jest.fn(() => ({ publish: jest.fn() })),
  EventTypes: {},
}));

jest.mock('../../../config/logger.config', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

// Mock transaction runner
jest.mock('../../../shared/transaction-runner', () => ({
  runWithLock: jest.fn(async (db, domain, id, callback) => callback(db)),
  LockDomain: { WAIVER: 'waiver' },
}));

describe('Waiver Determinism & Atomicity', () => {
  let mockPool: any;
  let mockClient: any;
  let mockCtx: ProcessWaiversContext;

  beforeEach(() => {
    mockClient = { query: jest.fn(), release: jest.fn() };
    mockPool = { connect: jest.fn().mockResolvedValue(mockClient), query: jest.fn() };

    mockCtx = {
      db: mockPool,
      leagueRepo: { findById: jest.fn() } as any,
      claimsRepo: {
        getPendingByLeagueWithCurrentPriority: jest.fn(),
        updateStatus: jest.fn(),
        snapshotClaimsForProcessingRun: jest.fn(),
        getPendingByProcessingRun: jest.fn(),
      } as any,
      rosterPlayersRepo: {
        getOwnedPlayerIdsByLeague: jest.fn().mockResolvedValue(new Set()),
        getPlayerIdsByRoster: jest.fn().mockResolvedValue([]),
      } as any,
      priorityRepo: { getMaxPriority: jest.fn().mockResolvedValue(10) } as any,
      faabRepo: { getByRoster: jest.fn() } as any,
      transactionsRepo: { create: jest.fn() } as any,
      waiverWireRepo: { removePlayer: jest.fn() } as any,
      processingRunsRepo: {
        tryCreate: jest.fn().mockResolvedValue({ id: 100 }),
        updateResults: jest.fn(),
        delete: jest.fn(),
      } as any,
      rosterRepo: {} as any,
      rosterMutationService: {
        addPlayerToRoster: jest.fn(),
        removePlayerFromRoster: jest.fn(),
      } as any,
    };

    // Default league setup
    (mockCtx.leagueRepo.findById as jest.Mock).mockResolvedValue({
      id: 1,
      season: '2024',
      settings: { waiver_type: 'faab' },
      activeLeagueSeasonId: 1,
    });
  });

  test('Determinism: Same bid amount and time should sort by ID', async () => {
    const now = new Date();
    // Create two claims with identical sorting criteria except ID
    const claims: WaiverClaimWithCurrentPriority[] = [
      {
        id: 200, // Higher ID (should lose tie-breaker)
        rosterId: 1,
        playerId: 10,
        bidAmount: 50,
        createdAt: now,
        claimOrder: 1,
        status: 'pending',
        priorityAtClaim: 1,
        currentPriority: 1,
      } as any,
      {
        id: 100, // Lower ID (should win tie-breaker)
        rosterId: 2,
        playerId: 10, // Same player
        bidAmount: 50, // Same bid
        createdAt: now, // Same time
        claimOrder: 1,
        status: 'pending',
        priorityAtClaim: 1,
        currentPriority: 1,
      } as any,
    ];

    (mockCtx.claimsRepo.getPendingByProcessingRun as jest.Mock).mockResolvedValue(claims);
    (mockCtx.faabRepo.getByRoster as jest.Mock).mockResolvedValue({ remainingBudget: 100 });

    await processLeagueClaims(mockCtx, 1);

    // Verify ID 100 won (processed successfully)
    expect(mockCtx.claimsRepo.updateStatus).toHaveBeenCalledWith(
      100,
      'successful',
      undefined,
      expect.anything()
    );
    // Verify ID 200 lost (outbid/tie-breaker)
    expect(mockCtx.claimsRepo.updateStatus).toHaveBeenCalledWith(
      200,
      'failed',
      'Outbid by another team',
      expect.anything()
    );
  });

  test('Chain Blocking: Conditional drop should fail if player already dropped', async () => {
    // Setup: Roster 1 has Player A (id: 50).
    // Claim 1: Add B, Drop A.
    // Claim 2: Add C, Drop A.

    const claims: WaiverClaimWithCurrentPriority[] = [
      {
        id: 1,
        rosterId: 1,
        playerId: 101,
        dropPlayerId: 50,
        claimOrder: 1,
        bidAmount: 10,
        status: 'pending',
        createdAt: new Date(),
      } as any,
      {
        id: 2,
        rosterId: 1,
        playerId: 102,
        dropPlayerId: 50,
        claimOrder: 2,
        bidAmount: 10,
        status: 'pending',
        createdAt: new Date(),
      } as any,
    ];

    (mockCtx.claimsRepo.getPendingByProcessingRun as jest.Mock).mockResolvedValue(claims);

    // Initial state: Roster 1 owns Player 50
    (mockCtx.rosterPlayersRepo.getPlayerIdsByRoster as jest.Mock).mockResolvedValue([50]);
    (mockCtx.faabRepo.getByRoster as jest.Mock).mockResolvedValue({ remainingBudget: 100 });

    await processLeagueClaims(mockCtx, 1);

    // Claim 1 should succeed
    expect(mockCtx.claimsRepo.updateStatus).toHaveBeenCalledWith(
      1,
      'successful',
      undefined,
      expect.anything()
    );

    // Claim 2 should fail because Player 50 was already dropped by Claim 1
    expect(mockCtx.claimsRepo.updateStatus).toHaveBeenCalledWith(
      2,
      'invalid',
      'Drop player no longer on roster',
      expect.anything()
    );
  });

  test('Atomicity: Error in one claim should not rollback entire league', async () => {
    const claims: WaiverClaimWithCurrentPriority[] = [
      {
        id: 1,
        rosterId: 1,
        playerId: 10,
        bidAmount: 50,
        status: 'pending',
        createdAt: new Date(),
      } as any,
      {
        id: 2,
        rosterId: 2,
        playerId: 11,
        bidAmount: 50,
        status: 'pending',
        createdAt: new Date(),
      } as any,
    ];

    (mockCtx.claimsRepo.getPendingByProcessingRun as jest.Mock).mockResolvedValue(claims);
    (mockCtx.faabRepo.getByRoster as jest.Mock).mockResolvedValue({ remainingBudget: 100 });

    // Mock transactionsRepo.create to throw for the first claim
    (mockCtx.transactionsRepo.create as jest.Mock)
      .mockRejectedValueOnce(new Error('Database constraint violation')) // Fail Claim 1
      .mockResolvedValue(true); // Succeed Claim 2

    await processLeagueClaims(mockCtx, 1);

    // Claim 1 should be marked failed (handled error)
    expect(mockCtx.claimsRepo.updateStatus).toHaveBeenCalledWith(
      1,
      'failed',
      'System error during processing',
      expect.anything()
    );

    // Claim 2 should still succeed
    expect(mockCtx.claimsRepo.updateStatus).toHaveBeenCalledWith(
      2,
      'successful',
      undefined,
      expect.anything()
    );
  });
});

describe('compareClaims()', () => {
  function makeClaim(
    overrides: Partial<WaiverClaimWithCurrentPriority>
  ): WaiverClaimWithCurrentPriority {
    return {
      id: 1,
      rosterId: 1,
      playerId: 10,
      bidAmount: 0,
      createdAt: new Date('2024-01-01T00:00:00Z'),
      claimOrder: 1,
      status: 'pending',
      priorityAtClaim: 1,
      currentPriority: 1,
      leagueId: 1,
      dropPlayerId: null,
      season: 2024,
      week: 1,
      ...overrides,
    } as WaiverClaimWithCurrentPriority;
  }

  function makeStates(
    entries: Array<{ rosterId: number; priority: number }>
  ): Map<number, RosterProcessingState> {
    const map = new Map<number, RosterProcessingState>();
    for (const e of entries) {
      map.set(e.rosterId, {
        rosterId: e.rosterId,
        currentPriority: e.priority,
        remainingBudget: 100,
        currentRosterSize: 5,
        ownedPlayerIds: new Set(),
        processedClaimIds: new Set(),
      });
    }
    return map;
  }

  test('FAAB: same bid + same priority → earlier timestamp wins', () => {
    const earlier = new Date('2024-01-01T10:00:00Z');
    const later = new Date('2024-01-01T10:00:01Z');
    const states = makeStates([
      { rosterId: 1, priority: 3 },
      { rosterId: 2, priority: 3 },
    ]);

    const a = makeClaim({ id: 10, rosterId: 1, bidAmount: 50, createdAt: earlier });
    const b = makeClaim({ id: 20, rosterId: 2, bidAmount: 50, createdAt: later });

    expect(compareClaims(a, b, 'faab', states)).toBeLessThan(0);
    expect(compareClaims(b, a, 'faab', states)).toBeGreaterThan(0);
  });

  test('FAAB: same bid + same priority + same timestamp → lower ID wins', () => {
    const now = new Date('2024-01-01T10:00:00Z');
    const states = makeStates([
      { rosterId: 1, priority: 3 },
      { rosterId: 2, priority: 3 },
    ]);

    const a = makeClaim({ id: 5, rosterId: 1, bidAmount: 50, createdAt: now });
    const b = makeClaim({ id: 99, rosterId: 2, bidAmount: 50, createdAt: now });

    expect(compareClaims(a, b, 'faab', states)).toBeLessThan(0);
    expect(compareClaims(b, a, 'faab', states)).toBeGreaterThan(0);
  });

  test('Standard: same priority → earlier timestamp wins', () => {
    const earlier = new Date('2024-01-01T10:00:00Z');
    const later = new Date('2024-01-01T10:00:01Z');
    const states = makeStates([
      { rosterId: 1, priority: 5 },
      { rosterId: 2, priority: 5 },
    ]);

    const a = makeClaim({ id: 10, rosterId: 1, createdAt: earlier });
    const b = makeClaim({ id: 20, rosterId: 2, createdAt: later });

    expect(compareClaims(a, b, 'standard', states)).toBeLessThan(0);
    expect(compareClaims(b, a, 'standard', states)).toBeGreaterThan(0);
  });
});
