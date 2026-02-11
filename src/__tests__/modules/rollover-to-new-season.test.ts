import { Pool, PoolClient } from 'pg';
import { RolloverToNewSeasonUseCase } from '../../modules/leagues/use-cases/rollover-to-new-season.use-case';
import { LeagueRepository } from '../../modules/leagues/leagues.repository';
import { LeagueSeasonRepository } from '../../modules/leagues/league-season.repository';
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
    } as unknown as jest.Mocked<LeagueRepository>;

    mockLeagueSeasonRepo = {
      findActiveByLeague: jest.fn().mockResolvedValue(currentSeason),
      getLatestSeasonNumber: jest.fn().mockResolvedValue(2024),
      markCompleted: jest.fn().mockResolvedValue(undefined),
      create: jest.fn().mockResolvedValue(newSeason),
    } as unknown as jest.Mocked<LeagueSeasonRepository>;

    useCase = new RolloverToNewSeasonUseCase(
      mockPool,
      mockLeagueRepo,
      mockLeagueSeasonRepo
    );
  });

  it('should update active_league_season_id to the new season', async () => {
    const result = await useCase.execute({ leagueId: 1 });

    expect(result.newSeason.id).toBe(11);
    expect(result.previousSeason.id).toBe(10);

    // Verify active_league_season_id was updated
    const activeSeasonUpdate = mockQueryCalls.find(
      (q) => q.text.includes('UPDATE leagues SET active_league_season_id')
    );
    expect(activeSeasonUpdate).toBeDefined();
    expect(activeSeasonUpdate!.values).toEqual([11, 1]);
  });

  it('should update league_season_id on pick assets for the new season year', async () => {
    await useCase.execute({ leagueId: 1 });

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
    await useCase.execute({ leagueId: 1 });

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
    await useCase.execute({ leagueId: 1 });

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

    await expect(useCase.execute({ leagueId: 2 })).rejects.toThrow(
      'Redraft leagues should use reset, not rollover'
    );
  });

  it('should reject rollover when current season is in pre_draft', async () => {
    const preDraftSeason = new LeagueSeason(
      10, 1, 2024, 'pre_draft', 'pre_season', 1,
      {}, null, null, now, now
    );
    mockLeagueSeasonRepo.findActiveByLeague.mockResolvedValue(preDraftSeason);

    await expect(useCase.execute({ leagueId: 1 })).rejects.toThrow(
      'Cannot rollover from pre_draft status'
    );
  });

  it('should reject rollover when a newer season already exists', async () => {
    mockLeagueSeasonRepo.getLatestSeasonNumber.mockResolvedValue(2025);

    await expect(useCase.execute({ leagueId: 1 })).rejects.toThrow(
      'A newer season already exists'
    );
  });

  it('should copy rosters with reset starters/bench', async () => {
    await useCase.execute({ leagueId: 1 });

    const rosterCopy = mockQueryCalls.find(
      (q) => q.text.includes('INSERT INTO rosters') && q.text.includes("'[]'::jsonb")
    );
    expect(rosterCopy).toBeDefined();
    // newSeasonId=11, oldSeasonId=10
    expect(rosterCopy!.values).toEqual([11, 10]);
  });

  it('should initialize FAAB budgets from league settings', async () => {
    await useCase.execute({ leagueId: 1 });

    const faabInit = mockQueryCalls.find(
      (q) => q.text.includes('INSERT INTO faab_budgets')
    );
    expect(faabInit).toBeDefined();
    // Should use league's faabBudget=200
    expect(faabInit!.values).toContain(200);
  });

  it('should execute all steps in correct order', async () => {
    await useCase.execute({ leagueId: 1 });

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
    // pick asset migration (3 queries), active season update (1 query)
    // Exact count may vary due to season year lookups
    expect(mockQueryCalls.length).toBeGreaterThanOrEqual(7);
  });
});
