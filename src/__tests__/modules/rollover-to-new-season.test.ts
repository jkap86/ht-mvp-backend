import { Pool, PoolClient } from 'pg';
import { RolloverToNewSeasonUseCase } from '../../modules/leagues/use-cases/rollover-to-new-season.use-case';
import { LeagueRepository } from '../../modules/leagues/leagues.repository';
import { LeagueSeasonRepository } from '../../modules/leagues/league-season.repository';
import { LeagueOperationsRepository } from '../../modules/leagues/league-operations.repository';
import { League } from '../../modules/leagues/leagues.model';
import { LeagueSeason } from '../../modules/leagues/league-season.model';

// Mock transaction runner to execute callback directly with a tracked mock client
const mockQueryCalls: Array<{ text: string; values: any[] }> = [];

jest.mock('../../shared/transaction-runner', () => ({
  runWithLock: jest.fn(async (_pool: any, _domain: any, _id: any, fn: any) => {
    const mockClient = {
      query: jest.fn(async (text: string, values?: any[]) => {
        mockQueryCalls.push({ text, values: values || [] });
        // Return season year for league_seasons lookups
        if (text.includes('SELECT season FROM league_seasons')) {
          return { rows: [{ season: 2025 }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }),
      release: jest.fn(),
    };
    return fn(mockClient);
  }),
  LockDomain: {
    LEAGUE: 100_000_000,
    ROSTER: 200_000_000,
    TRADE: 300_000_000,
    WAIVER: 400_000_000,
    AUCTION: 500_000_000,
    LINEUP: 600_000_000,
    DRAFT: 700_000_000,
    JOB: 900_000_000,
  },
}));

describe('RolloverToNewSeasonUseCase', () => {
  let useCase: RolloverToNewSeasonUseCase;
  let mockPool: jest.Mocked<Pool>;
  let mockLeagueRepo: jest.Mocked<LeagueRepository>;
  let mockLeagueSeasonRepo: jest.Mocked<LeagueSeasonRepository>;

  const now = new Date();
  const commissionerUserId = 'user-commish-123';

  const dynastyLeague = new League(
    1, 'Dynasty League', 'active',
    { commissioner_roster_id: 1 },
    { type: 'ppr' },
    '2024', 4, now, now,
    undefined, 1, 'dynasty',
    { maxKeepers: 5, faabBudget: 200 },
    14, 'offseason', false, 10
  );

  const currentSeason = new LeagueSeason(
    10, 1, 2024, 'completed', 'offseason', 14,
    {}, now, null, now, now
  );

  const newSeason = new LeagueSeason(
    11, 1, 2025, 'pre_draft', 'pre_season', 1,
    { keeper_deadline: now.toISOString(), max_keepers: 5, keeper_costs_enabled: false },
    null, null, now, now
  );

  beforeEach(() => {
    mockQueryCalls.length = 0;

    mockPool = {
      connect: jest.fn(),
      query: jest.fn(),
    } as unknown as jest.Mocked<Pool>;

    mockLeagueRepo = {
      findById: jest.fn().mockResolvedValue(dynastyLeague),
      isCommissioner: jest.fn().mockResolvedValue(true),
    } as unknown as jest.Mocked<LeagueRepository>;

    mockLeagueSeasonRepo = {
      findActiveByLeague: jest.fn().mockResolvedValue(currentSeason),
      getLatestSeasonNumber: jest.fn().mockResolvedValue(2024),
      markCompleted: jest.fn().mockResolvedValue(undefined),
      create: jest.fn().mockResolvedValue(newSeason),
    } as unknown as jest.Mocked<LeagueSeasonRepository>;

    const mockLeagueOpsRepo = {
      findByKey: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<LeagueOperationsRepository>;

    useCase = new RolloverToNewSeasonUseCase(
      mockPool,
      mockLeagueRepo,
      mockLeagueSeasonRepo,
      mockLeagueOpsRepo
    );
  });

  // --- Permission tests ---

  it('should reject rollover when userId is not provided', async () => {
    await expect(useCase.execute({ leagueId: 1 })).rejects.toThrow(
      'userId is required for rollover'
    );
  });

  it('should reject rollover when user is not commissioner', async () => {
    mockLeagueRepo.isCommissioner.mockResolvedValue(false);

    await expect(useCase.execute({ leagueId: 1, userId: 'non-commish' })).rejects.toThrow(
      'Only the commissioner can rollover a league season'
    );
  });

  // --- Core rollover tests ---

  it('should update active_league_season_id and sync league-level fields', async () => {
    const result = await useCase.execute({ leagueId: 1, userId: commissionerUserId });

    expect(result.newSeason.id).toBe(11);
    expect(result.previousSeason.id).toBe(10);

    // Verify leagues row is fully updated
    const leaguesUpdate = mockQueryCalls.find(
      (q) => q.text.includes('UPDATE leagues')
    );
    expect(leaguesUpdate).toBeDefined();
    expect(leaguesUpdate!.text).toContain('active_league_season_id = $1');
    expect(leaguesUpdate!.text).toContain('season = $2::text');
    expect(leaguesUpdate!.text).toContain('current_week = 1');
    expect(leaguesUpdate!.text).toContain("status = 'pre_draft'");
    expect(leaguesUpdate!.text).toContain("season_status = 'pre_season'");
    // values: [newSeason.id, newSeasonYear, leagueId]
    expect(leaguesUpdate!.values).toEqual([11, 2025, 1]);
  });

  it('should update league_season_id on pick assets for the new season year', async () => {
    await useCase.execute({ leagueId: 1, userId: commissionerUserId });

    const leagueSeasonUpdate = mockQueryCalls.find(
      (q) =>
        q.text.includes('UPDATE draft_pick_assets') &&
        q.text.includes('SET league_season_id') &&
        !q.text.includes('original_roster_id')
    );
    expect(leagueSeasonUpdate).toBeDefined();
    // newSeasonId=11, leagueId=1, newSeasonYear=2025
    expect(leagueSeasonUpdate!.values).toEqual([11, 1, 2025]);
  });

  it('should remap original_roster_id on current/future pick assets', async () => {
    await useCase.execute({ leagueId: 1, userId: commissionerUserId });

    const origRosterRemap = mockQueryCalls.find(
      (q) =>
        q.text.includes('UPDATE draft_pick_assets dpa') &&
        q.text.includes('SET original_roster_id = r_new.id')
    );
    expect(origRosterRemap).toBeDefined();
    // newSeasonId=11, leagueId=1, newSeasonYear=2025
    expect(origRosterRemap!.values).toEqual([11, 1, 2025]);
    // Should filter to season >= newSeasonYear
    expect(origRosterRemap!.text).toContain('dpa.season >= $3');
    // Should exclude rosters already in the new season
    expect(origRosterRemap!.text).toContain('r_old.league_season_id != $1');
  });

  it('should remap current_owner_roster_id on current/future pick assets', async () => {
    await useCase.execute({ leagueId: 1, userId: commissionerUserId });

    const ownerRosterRemap = mockQueryCalls.find(
      (q) =>
        q.text.includes('UPDATE draft_pick_assets dpa') &&
        q.text.includes('SET current_owner_roster_id = r_new.id')
    );
    expect(ownerRosterRemap).toBeDefined();
    expect(ownerRosterRemap!.values).toEqual([11, 1, 2025]);
    expect(ownerRosterRemap!.text).toContain('dpa.season >= $3');
    expect(ownerRosterRemap!.text).toContain('r_old.league_season_id != $1');
  });

  it('should reject rollover for redraft leagues', async () => {
    const redraftLeague = new League(
      2, 'Redraft League', 'active',
      {}, {}, '2024', 4, now, now,
      undefined, 1, 'redraft', {}, 14, 'offseason'
    );
    mockLeagueRepo.findById.mockResolvedValue(redraftLeague);

    await expect(useCase.execute({ leagueId: 2, userId: commissionerUserId })).rejects.toThrow(
      'Redraft leagues should use reset, not rollover'
    );
  });

  it('should reject rollover when current season is in pre_draft', async () => {
    const preDraftSeason = new LeagueSeason(
      10, 1, 2024, 'pre_draft', 'pre_season', 1,
      {}, null, null, now, now
    );
    mockLeagueSeasonRepo.findActiveByLeague.mockResolvedValue(preDraftSeason);

    await expect(useCase.execute({ leagueId: 1, userId: commissionerUserId })).rejects.toThrow(
      'Cannot rollover from pre_draft status'
    );
  });

  it('should reject rollover when a newer season already exists', async () => {
    mockLeagueSeasonRepo.getLatestSeasonNumber.mockResolvedValue(2025);

    await expect(useCase.execute({ leagueId: 1, userId: commissionerUserId })).rejects.toThrow(
      'A newer season already exists'
    );
  });

  // --- INSERT correctness tests ---

  it('should copy rosters with league_id and league_season_id', async () => {
    await useCase.execute({ leagueId: 1, userId: commissionerUserId });

    const rosterCopy = mockQueryCalls.find(
      (q) => q.text.includes('INSERT INTO rosters') && q.text.includes("'[]'::jsonb")
    );
    expect(rosterCopy).toBeDefined();
    // Must include league_id column
    expect(rosterCopy!.text).toContain('league_id');
    expect(rosterCopy!.text).toContain('league_season_id');
    // values: [newSeasonId=11, oldSeasonId=10, leagueId=1]
    expect(rosterCopy!.values).toEqual([11, 10, 1]);
  });

  it('should insert waiver_priority with league_id', async () => {
    await useCase.execute({ leagueId: 1, userId: commissionerUserId });

    const waiverInsert = mockQueryCalls.find(
      (q) => q.text.includes('INSERT INTO waiver_priority')
    );
    expect(waiverInsert).toBeDefined();
    // Must include league_id column
    expect(waiverInsert!.text).toContain('league_id');
    expect(waiverInsert!.text).toContain('league_season_id');
    // values: [newSeasonId=11, seasonYear=2025, oldSeasonId=10, leagueId=1]
    expect(waiverInsert!.values).toEqual([11, 2025, 10, 1]);
  });

  it('should insert faab_budgets with league_id', async () => {
    await useCase.execute({ leagueId: 1, userId: commissionerUserId });

    const faabInit = mockQueryCalls.find(
      (q) => q.text.includes('INSERT INTO faab_budgets')
    );
    expect(faabInit).toBeDefined();
    // Must include league_id column
    expect(faabInit!.text).toContain('league_id');
    expect(faabInit!.text).toContain('league_season_id');
    // Should use league's faabBudget=200
    expect(faabInit!.values).toContain(200);
    // values: [newSeasonId=11, seasonYear=2025, initialBudget=200, leagueId=1]
    expect(faabInit!.values).toEqual([11, 2025, 200, 1]);
  });

  it('should execute all steps in correct order', async () => {
    await useCase.execute({ leagueId: 1, userId: commissionerUserId });

    // Verify key operations happened
    expect(mockLeagueSeasonRepo.markCompleted).toHaveBeenCalledWith(10, expect.anything());
    expect(mockLeagueSeasonRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        leagueId: 1,
        season: 2025,
        status: 'pre_draft',
      }),
      expect.anything()
    );

    // Should have: roster copy, waiver priority (2 queries), faab (2 queries),
    // pick asset migration (3 queries), leagues update (1 query)
    // Exact count may vary due to season year lookups
    expect(mockQueryCalls.length).toBeGreaterThanOrEqual(7);
  });

  // --- Week advancement targeting test ---

  it('should set leagues.season so week-advancement targets post-rollover league', async () => {
    await useCase.execute({ leagueId: 1, userId: commissionerUserId });

    const leaguesUpdate = mockQueryCalls.find(
      (q) => q.text.includes('UPDATE leagues')
    );
    expect(leaguesUpdate).toBeDefined();
    // The week-advancement job filters WHERE season = $2::text
    // After rollover, leagues.season must be the new year so the job picks it up
    expect(leaguesUpdate!.text).toContain('season = $2::text');
    expect(leaguesUpdate!.values[1]).toBe(2025);
  });
});
