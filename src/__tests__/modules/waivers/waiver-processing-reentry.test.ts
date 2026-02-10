import { Pool, PoolClient } from 'pg';
import { processLeagueClaims, ProcessWaiversContext } from '../../../modules/waivers/use-cases/process-waivers.use-case';
import { WaiverClaimsRepository } from '../../../modules/waivers/waiver-claims.repository';
import {
  RosterPlayersRepository,
  RosterTransactionsRepository,
} from '../../../modules/rosters/rosters.repository';
import { WaiverWireRepository } from '../../../modules/waivers/waivers.repository';
import { LeagueRepository, RosterRepository } from '../../../modules/leagues/leagues.repository';

// Mock transaction runner
const mockClient = { query: jest.fn() } as unknown as PoolClient;
jest.mock('../../../shared/transaction-runner', () => ({
  runWithLock: jest.fn(async (_pool: any, _domain: any, _id: any, fn: any) => {
    return fn(mockClient);
  }),
  runInTransaction: jest.fn(async (_pool: any, fn: any) => fn(mockClient)),
  LockDomain: { WAIVER: 'WAIVER' },
}));

// Mock events
jest.mock('../../../shared/events', () => ({
  tryGetEventBus: jest.fn(() => ({
    publish: jest.fn(),
  })),
  EventTypes: {
    WAIVER_CLAIMED: 'WAIVER_CLAIMED',
    WAIVER_FAILED: 'WAIVER_FAILED',
    TRADE_INVALIDATED: 'TRADE_INVALIDATED',
  },
}));

jest.mock('../../../config/logger.config', () => ({
  logger: { warn: jest.fn(), info: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

// Mock socket
jest.mock('../../../socket', () => ({
  tryGetSocketService: jest.fn(() => ({
    emitWaiverClaimSuccessful: jest.fn(),
    emitWaiverClaimFailed: jest.fn(),
    emitWaiverPriorityUpdate: jest.fn(),
  })),
}));

describe('processLeagueClaims — re-entry protection', () => {
  let ctx: ProcessWaiversContext;
  let mockProcessingRunsRepo: any;

  beforeEach(() => {
    mockProcessingRunsRepo = {
      tryCreate: jest.fn(),
      updateStatus: jest.fn(),
    };

    ctx = {
      db: {} as Pool,
      leagueRepo: {
        findById: jest.fn().mockResolvedValue({
          id: 1,
          season: '2024',
          currentWeek: 5,
          settings: { waiver_type: 'priority', waiver_period_days: 2 },
          activeLeagueSeasonId: 100,
        }),
      } as unknown as jest.Mocked<LeagueRepository>,
      rosterRepo: {} as jest.Mocked<RosterRepository>,
      claimsRepo: {
        getPendingByLeagueWithCurrentPriority: jest.fn(),
        getPendingByProcessingRun: jest.fn(),
        snapshotClaimsForProcessingRun: jest.fn(),
        updateStatus: jest.fn(),
      } as unknown as jest.Mocked<WaiverClaimsRepository>,
      rosterPlayersRepo: {
        getOwnedPlayerIdsByLeague: jest.fn().mockResolvedValue(new Set()),
        getPlayerCount: jest.fn().mockResolvedValue(0),
      } as unknown as jest.Mocked<RosterPlayersRepository>,
      transactionsRepo: {} as jest.Mocked<RosterTransactionsRepository>,
      waiverWireRepo: {
        removePlayer: jest.fn(),
        getByLeague: jest.fn(),
        isOnWaivers: jest.fn(),
        getPlayerExpiration: jest.fn(),
        addPlayer: jest.fn(),
      } as unknown as jest.Mocked<WaiverWireRepository>,
      priorityRepo: {
        getByRoster: jest.fn(),
        rotateAfterWin: jest.fn(),
        initializeForLeague: jest.fn(),
        ensureRosterPriority: jest.fn(),
      } as any,
      faabRepo: {
        getByRoster: jest.fn(),
        deductBudget: jest.fn(),
        getByLeague: jest.fn(),
        initializeForLeague: jest.fn(),
        ensureRosterBudget: jest.fn(),
      } as any,
      processingRunsRepo: mockProcessingRunsRepo,
    };
  });

  it('should skip processing when a run already exists for the same window (re-entry)', async () => {
    // tryCreate returns null → a run already exists for this window
    mockProcessingRunsRepo.tryCreate.mockResolvedValue(null);

    const result = await processLeagueClaims(ctx, 1);

    // Should return zero processed (no-op)
    expect(result).toEqual({ processed: 0, successful: 0 });

    // Should NOT have fetched any claims
    expect(ctx.claimsRepo.getPendingByProcessingRun).not.toHaveBeenCalled();
    expect(ctx.claimsRepo.getPendingByLeagueWithCurrentPriority).not.toHaveBeenCalled();
  });

  it('should process claims when no prior run exists for this window', async () => {
    // tryCreate returns a new run (first invocation)
    mockProcessingRunsRepo.tryCreate.mockResolvedValue({ id: 42 });

    // Snapshot returns 0 claims
    (ctx.claimsRepo.snapshotClaimsForProcessingRun as jest.Mock).mockResolvedValue(0);

    // No claims to process
    (ctx.claimsRepo.getPendingByProcessingRun as jest.Mock).mockResolvedValue([]);

    const result = await processLeagueClaims(ctx, 1);

    expect(result).toEqual({ processed: 0, successful: 0 });

    // Should have called tryCreate
    expect(mockProcessingRunsRepo.tryCreate).toHaveBeenCalledWith(
      1, // leagueId
      2024, // season
      5, // currentWeek
      expect.any(Date), // windowStart
      expect.anything() // client
    );

    // Should have called snapshot
    expect(ctx.claimsRepo.snapshotClaimsForProcessingRun).toHaveBeenCalledWith(
      1, 2024, 5, 42, expect.anything()
    );
  });

  it('should process normally without processingRunsRepo (legacy mode)', async () => {
    // Remove processing runs repo
    delete (ctx as any).processingRunsRepo;

    // Return empty claims (legacy path)
    (ctx.claimsRepo.getPendingByLeagueWithCurrentPriority as jest.Mock).mockResolvedValue([]);

    const result = await processLeagueClaims(ctx, 1);

    expect(result).toEqual({ processed: 0, successful: 0 });

    // Should have used the legacy path
    expect(ctx.claimsRepo.getPendingByLeagueWithCurrentPriority).toHaveBeenCalled();
  });
});
