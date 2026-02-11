import { MatchupService } from '../../../modules/matchups/matchups.service';
import { MatchupsRepository } from '../../../modules/matchups/matchups.repository';
import { LineupsRepository } from '../../../modules/lineups/lineups.repository';
import { LeagueRepository, RosterRepository } from '../../../modules/leagues/leagues.repository';
import { ScoringService } from '../../../modules/scoring/scoring.service';
import { PlayerRepository } from '../../../modules/players/players.repository';
import { PlayerStatsRepository } from '../../../modules/scoring/scoring.repository';
import { GameProgressService } from '../../../modules/scoring/game-progress.service';
import { MedianService } from '../../../modules/matchups/median.service';
import { BestballService } from '../../../modules/bestball/bestball.service';
import { League } from '../../../modules/leagues/leagues.model';
import { MatchupDetails, Matchup } from '../../../modules/matchups/matchups.model';
import { RosterLineup, LineupSlots } from '../../../modules/lineups/lineups.model';
import {
  ForbiddenException,
  BadRequestException,
  NotFoundException,
  ValidationException,
} from '../../../utils/exceptions';

// Mock transaction runner so runWithLocks just executes the callback immediately
jest.mock('../../../shared/transaction-runner', () => ({
  runWithLocks: jest.fn(async (_pool: any, _locks: any, fn: (client: any) => Promise<any>) => {
    const fakeClient = {};
    return fn(fakeClient);
  }),
  runInTransaction: jest.fn(async (_pool: any, fn: (client: any) => Promise<any>) => {
    const fakeClient = {};
    return fn(fakeClient);
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

// Mock scoring helpers
jest.mock('../../../modules/scoring/scoring-settings-normalizer', () => ({
  normalizeLeagueScoringSettings: jest.fn().mockReturnValue({
    scoringType: 'ppr',
    rules: {
      passYards: 0.04,
      passTd: 4,
      passInt: -2,
      rushYards: 0.1,
      rushTd: 6,
      recYards: 0.1,
      recTd: 6,
      reception: 1,
    },
  }),
}));

jest.mock('../../../modules/scoring/scoring-calculator', () => ({
  calculatePlayerPoints: jest.fn().mockReturnValue(12.5),
}));

// --- Mock Data ---

const LEAGUE_ID = 1;
const SEASON = 2025;
const WEEK = 5;
const USER_ID = 'user-abc';
const COMMISSIONER_ID = 'commissioner-xyz';
const MATCHUP_ID = 100;
const ROSTER_1_ID = 10;
const ROSTER_2_ID = 20;

const mockLeague = new League(
  LEAGUE_ID,
  'Test League',
  'active',
  { commissioner_roster_id: 1 },
  { scoring_type: 'ppr' },
  String(SEASON),
  10,
  new Date(),
  new Date(),
  undefined,
  undefined,
  'redraft',
  { useLeagueMedian: false },
  WEEK,
  'regular_season'
);

const mockMatchupDetails: MatchupDetails = {
  id: MATCHUP_ID,
  leagueId: LEAGUE_ID,
  season: SEASON,
  week: WEEK,
  roster1Id: ROSTER_1_ID,
  roster2Id: ROSTER_2_ID,
  roster1Points: 105.5,
  roster2Points: 98.3,
  isPlayoff: false,
  isFinal: false,
  createdAt: new Date(),
  roster1TeamName: 'Team Alpha',
  roster2TeamName: 'Team Beta',
};

const mockMatchup: Matchup = {
  id: MATCHUP_ID,
  leagueId: LEAGUE_ID,
  season: SEASON,
  week: WEEK,
  roster1Id: ROSTER_1_ID,
  roster2Id: ROSTER_2_ID,
  roster1Points: 105.5,
  roster2Points: 98.3,
  isPlayoff: false,
  isFinal: false,
  createdAt: new Date(),
};

const createEmptyLineupSlots = (): LineupSlots => ({
  QB: [],
  RB: [],
  WR: [],
  TE: [],
  FLEX: [],
  SUPER_FLEX: [],
  REC_FLEX: [],
  K: [],
  DEF: [],
  DL: [],
  LB: [],
  DB: [],
  IDP_FLEX: [],
  BN: [],
  IR: [],
  TAXI: [],
});

const createMockLineup = (rosterId: number, playerIds: { QB: number[]; RB: number[]; BN: number[] }): RosterLineup => ({
  id: rosterId * 100,
  rosterId,
  season: SEASON,
  week: WEEK,
  lineup: {
    ...createEmptyLineupSlots(),
    QB: playerIds.QB,
    RB: playerIds.RB,
    BN: playerIds.BN,
  },
  totalPoints: 105.5,
  totalPointsLive: null,
  totalPointsProjectedLive: null,
  isLocked: false,
  isBestball: false,
  bestballGeneratedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
});

// --- Mock factories ---

const createMockMatchupsRepo = (): jest.Mocked<MatchupsRepository> =>
  ({
    findById: jest.fn(),
    findByIdWithDetails: jest.fn(),
    findByLeagueAndWeek: jest.fn(),
    findByLeagueAndWeekWithDetails: jest.fn(),
    findAllByLeagueAndSeason: jest.fn(),
    findAllByLeagueAndSeasonWithDetails: jest.fn(),
    findByRosterAndWeek: jest.fn(),
    getMaxScheduledWeek: jest.fn(),
    updatePoints: jest.fn(),
    finalize: jest.fn(),
    create: jest.fn(),
    getStandings: jest.fn(),
    countByLeagueSeason: jest.fn(),
    deleteByLeague: jest.fn(),
    getLeaguesWithActiveMatchups: jest.fn(),
    hasAnyFinalizedMatchups: jest.fn(),
    findMatchupsInWeekRange: jest.fn(),
    getFinalizedByRoster: jest.fn(),
    getFinalizedByLeague: jest.fn(),
  }) as unknown as jest.Mocked<MatchupsRepository>;

const createMockLineupsRepo = (): jest.Mocked<LineupsRepository> =>
  ({
    findByRosterAndWeek: jest.fn(),
    upsert: jest.fn(),
    updatePoints: jest.fn(),
    updateLivePoints: jest.fn(),
    batchUpdateLivePoints: jest.fn(),
    lockLineups: jest.fn(),
    getByLeagueAndWeek: jest.fn(),
    isLocked: jest.fn(),
    lockLineupsForWeekByLockTime: jest.fn(),
    upsertBestball: jest.fn(),
    batchUpsertBestball: jest.fn(),
  }) as unknown as jest.Mocked<LineupsRepository>;

const createMockLeagueRepo = (): jest.Mocked<LeagueRepository> =>
  ({
    findById: jest.fn(),
    isUserMember: jest.fn(),
    isCommissioner: jest.fn(),
  }) as unknown as jest.Mocked<LeagueRepository>;

const createMockRosterRepo = (): jest.Mocked<RosterRepository> =>
  ({
    findByIds: jest.fn(),
  }) as unknown as jest.Mocked<RosterRepository>;

const createMockScoringService = (): jest.Mocked<ScoringService> =>
  ({
    calculateWeeklyScores: jest.fn(),
  }) as unknown as jest.Mocked<ScoringService>;

const createMockPlayerRepo = (): jest.Mocked<PlayerRepository> =>
  ({
    findByIds: jest.fn(),
  }) as unknown as jest.Mocked<PlayerRepository>;

const createMockStatsRepo = (): jest.Mocked<PlayerStatsRepository> =>
  ({
    findByPlayersAndWeek: jest.fn(),
  }) as unknown as jest.Mocked<PlayerStatsRepository>;

const createMockGameProgressService = (): jest.Mocked<GameProgressService> =>
  ({
    hasGamesInProgress: jest.fn(),
  }) as unknown as jest.Mocked<GameProgressService>;

const createMockMedianService = (): jest.Mocked<MedianService> =>
  ({
    calculateAndStoreMedianResults: jest.fn(),
  }) as unknown as jest.Mocked<MedianService>;

const createMockBestballService = (): jest.Mocked<BestballService> =>
  ({
    generateBestballLineupsForLeague: jest.fn(),
  }) as unknown as jest.Mocked<BestballService>;

// --- Tests ---

describe('MatchupService', () => {
  let service: MatchupService;
  let mockDb: any;
  let matchupsRepo: jest.Mocked<MatchupsRepository>;
  let lineupsRepo: jest.Mocked<LineupsRepository>;
  let rosterRepo: jest.Mocked<RosterRepository>;
  let leagueRepo: jest.Mocked<LeagueRepository>;
  let scoringService: jest.Mocked<ScoringService>;
  let playerRepo: jest.Mocked<PlayerRepository>;
  let statsRepo: jest.Mocked<PlayerStatsRepository>;
  let gameProgressService: jest.Mocked<GameProgressService>;
  let medianService: jest.Mocked<MedianService>;
  let bestballService: jest.Mocked<BestballService>;

  beforeEach(() => {
    mockDb = {} as any;
    matchupsRepo = createMockMatchupsRepo();
    lineupsRepo = createMockLineupsRepo();
    rosterRepo = createMockRosterRepo();
    leagueRepo = createMockLeagueRepo();
    scoringService = createMockScoringService();
    playerRepo = createMockPlayerRepo();
    statsRepo = createMockStatsRepo();
    gameProgressService = createMockGameProgressService();
    medianService = createMockMedianService();
    bestballService = createMockBestballService();

    service = new MatchupService(
      mockDb,
      matchupsRepo,
      lineupsRepo,
      rosterRepo,
      leagueRepo,
      scoringService,
      playerRepo,
      statsRepo,
      medianService,
      gameProgressService,
      bestballService
    );
  });

  // -------------------------------------------------------
  // getWeekMatchups
  // -------------------------------------------------------
  describe('getWeekMatchups', () => {
    it('should return matchup details for a valid member', async () => {
      leagueRepo.isUserMember.mockResolvedValue(true);
      leagueRepo.findById.mockResolvedValue(mockLeague);
      matchupsRepo.findByLeagueAndWeekWithDetails.mockResolvedValue([mockMatchupDetails]);

      const result = await service.getWeekMatchups(LEAGUE_ID, WEEK, USER_ID);

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(MATCHUP_ID);
      expect(result[0].roster1TeamName).toBe('Team Alpha');
      expect(leagueRepo.isUserMember).toHaveBeenCalledWith(LEAGUE_ID, USER_ID);
      expect(leagueRepo.findById).toHaveBeenCalledWith(LEAGUE_ID);
      expect(matchupsRepo.findByLeagueAndWeekWithDetails).toHaveBeenCalledWith(LEAGUE_ID, SEASON, WEEK);
    });

    it('should throw ForbiddenException when user is not a league member', async () => {
      leagueRepo.isUserMember.mockResolvedValue(false);

      await expect(service.getWeekMatchups(LEAGUE_ID, WEEK, USER_ID)).rejects.toThrow(
        ForbiddenException
      );
      await expect(service.getWeekMatchups(LEAGUE_ID, WEEK, USER_ID)).rejects.toThrow(
        'You are not a member of this league'
      );
    });
  });

  // -------------------------------------------------------
  // getAllMatchups
  // -------------------------------------------------------
  describe('getAllMatchups', () => {
    it('should return all matchups for the league season', async () => {
      leagueRepo.isUserMember.mockResolvedValue(true);
      leagueRepo.findById.mockResolvedValue(mockLeague);
      matchupsRepo.findAllByLeagueAndSeasonWithDetails.mockResolvedValue([mockMatchupDetails]);

      const result = await service.getAllMatchups(LEAGUE_ID, USER_ID);

      expect(result).toHaveLength(1);
      expect(matchupsRepo.findAllByLeagueAndSeasonWithDetails).toHaveBeenCalledWith(LEAGUE_ID, SEASON);
    });

    it('should use seasonOverride when provided', async () => {
      const overrideSeason = 2024;
      leagueRepo.isUserMember.mockResolvedValue(true);
      leagueRepo.findById.mockResolvedValue(mockLeague);
      matchupsRepo.findAllByLeagueAndSeasonWithDetails.mockResolvedValue([]);

      const result = await service.getAllMatchups(LEAGUE_ID, USER_ID, overrideSeason);

      expect(result).toHaveLength(0);
      expect(matchupsRepo.findAllByLeagueAndSeasonWithDetails).toHaveBeenCalledWith(
        LEAGUE_ID,
        overrideSeason
      );
    });

    it('should throw ForbiddenException when user is not a league member', async () => {
      leagueRepo.isUserMember.mockResolvedValue(false);

      await expect(service.getAllMatchups(LEAGUE_ID, USER_ID)).rejects.toThrow(ForbiddenException);
    });
  });

  // -------------------------------------------------------
  // getMatchup
  // -------------------------------------------------------
  describe('getMatchup', () => {
    it('should return the matchup details for a valid member', async () => {
      matchupsRepo.findByIdWithDetails.mockResolvedValue(mockMatchupDetails);
      leagueRepo.isUserMember.mockResolvedValue(true);

      const result = await service.getMatchup(MATCHUP_ID, USER_ID);

      expect(result).not.toBeNull();
      expect(result!.id).toBe(MATCHUP_ID);
      expect(result!.roster1TeamName).toBe('Team Alpha');
      expect(matchupsRepo.findByIdWithDetails).toHaveBeenCalledWith(MATCHUP_ID);
      expect(leagueRepo.isUserMember).toHaveBeenCalledWith(LEAGUE_ID, USER_ID);
    });

    it('should return null when matchup does not exist', async () => {
      matchupsRepo.findByIdWithDetails.mockResolvedValue(null);

      const result = await service.getMatchup(999, USER_ID);

      expect(result).toBeNull();
      // Should not check membership if matchup doesn't exist
      expect(leagueRepo.isUserMember).not.toHaveBeenCalled();
    });

    it('should throw ForbiddenException when user is not a member of the matchup league', async () => {
      matchupsRepo.findByIdWithDetails.mockResolvedValue(mockMatchupDetails);
      leagueRepo.isUserMember.mockResolvedValue(false);

      await expect(service.getMatchup(MATCHUP_ID, USER_ID)).rejects.toThrow(ForbiddenException);
    });
  });

  // -------------------------------------------------------
  // getMatchupWithLineups
  // -------------------------------------------------------
  describe('getMatchupWithLineups', () => {
    it('should return null when matchup does not exist', async () => {
      matchupsRepo.findByIdWithDetails.mockResolvedValue(null);

      const result = await service.getMatchupWithLineups(999, USER_ID);

      expect(result).toBeNull();
    });

    it('should return matchup with full team lineups built', async () => {
      // getMatchup internals
      matchupsRepo.findByIdWithDetails.mockResolvedValue(mockMatchupDetails);
      leagueRepo.isUserMember.mockResolvedValue(true);

      // getMatchupWithLineups fetches league + lineups
      leagueRepo.findById.mockResolvedValue(mockLeague);

      const lineup1 = createMockLineup(ROSTER_1_ID, {
        QB: [101],
        RB: [102, 103],
        BN: [104],
      });
      const lineup2 = createMockLineup(ROSTER_2_ID, {
        QB: [201],
        RB: [202, 203],
        BN: [204],
      });
      lineupsRepo.findByRosterAndWeek
        .mockResolvedValueOnce(lineup1)
        .mockResolvedValueOnce(lineup2);

      // Mock player lookups
      playerRepo.findByIds.mockResolvedValue([
        { id: 101, fullName: 'Patrick Mahomes', position: 'QB', team: 'KC' } as any,
        { id: 102, fullName: 'Travis Etienne', position: 'RB', team: 'JAX' } as any,
        { id: 103, fullName: 'Saquon Barkley', position: 'RB', team: 'PHI' } as any,
        { id: 104, fullName: 'Bench Player A', position: 'WR', team: 'NYG' } as any,
        { id: 201, fullName: 'Josh Allen', position: 'QB', team: 'BUF' } as any,
        { id: 202, fullName: 'Derrick Henry', position: 'RB', team: 'BAL' } as any,
        { id: 203, fullName: 'Bijan Robinson', position: 'RB', team: 'ATL' } as any,
        { id: 204, fullName: 'Bench Player B', position: 'TE', team: 'SF' } as any,
      ]);

      // Mock stats lookups (empty stats -- calculatePlayerPoints is already mocked)
      statsRepo.findByPlayersAndWeek.mockResolvedValue([]);

      const result = await service.getMatchupWithLineups(MATCHUP_ID, USER_ID);

      expect(result).not.toBeNull();
      expect(result!.team1).toBeDefined();
      expect(result!.team2).toBeDefined();
      expect(result!.team1.rosterId).toBe(ROSTER_1_ID);
      expect(result!.team1.teamName).toBe('Team Alpha');
      expect(result!.team2.rosterId).toBe(ROSTER_2_ID);
      expect(result!.team2.teamName).toBe('Team Beta');

      // team1: QB(1) + RB(2) starters + BN(1) = 4 players
      // calculatePlayerPoints returns 0 because stats are empty (no match in statsMap)
      // but the players should still be listed
      expect(result!.team1.players).toHaveLength(4);
      expect(result!.team2.players).toHaveLength(4);

      // Check starter/bench classification
      const team1Starters = result!.team1.players.filter((p) => p.isStarter);
      const team1Bench = result!.team1.players.filter((p) => !p.isStarter);
      expect(team1Starters).toHaveLength(3); // QB + 2 RB
      expect(team1Bench).toHaveLength(1); // 1 BN

      // Verify lineup repo was called for both rosters
      expect(lineupsRepo.findByRosterAndWeek).toHaveBeenCalledWith(ROSTER_1_ID, SEASON, WEEK);
      expect(lineupsRepo.findByRosterAndWeek).toHaveBeenCalledWith(ROSTER_2_ID, SEASON, WEEK);
    });

    it('should return empty players array when lineup is not set', async () => {
      matchupsRepo.findByIdWithDetails.mockResolvedValue(mockMatchupDetails);
      leagueRepo.isUserMember.mockResolvedValue(true);
      leagueRepo.findById.mockResolvedValue(mockLeague);

      // No lineups exist
      lineupsRepo.findByRosterAndWeek.mockResolvedValue(null);

      const result = await service.getMatchupWithLineups(MATCHUP_ID, USER_ID);

      expect(result).not.toBeNull();
      expect(result!.team1.players).toHaveLength(0);
      expect(result!.team2.players).toHaveLength(0);
    });
  });

  // -------------------------------------------------------
  // finalizeWeekMatchups
  // -------------------------------------------------------
  describe('finalizeWeekMatchups', () => {
    it('should finalize matchups for commissioner', async () => {
      leagueRepo.isCommissioner.mockResolvedValue(true);
      leagueRepo.findById.mockResolvedValue(mockLeague);
      matchupsRepo.getMaxScheduledWeek.mockResolvedValue(17);
      gameProgressService.hasGamesInProgress.mockResolvedValue(false);
      scoringService.calculateWeeklyScores.mockResolvedValue(undefined);
      matchupsRepo.findByLeagueAndWeek.mockResolvedValue([mockMatchup]);

      const mockLineupData: RosterLineup = createMockLineup(ROSTER_1_ID, { QB: [101], RB: [], BN: [] });
      mockLineupData.totalPoints = 105.5;
      const mockLineupData2: RosterLineup = createMockLineup(ROSTER_2_ID, { QB: [201], RB: [], BN: [] });
      mockLineupData2.totalPoints = 98.3;

      lineupsRepo.getByLeagueAndWeek.mockResolvedValue([mockLineupData, mockLineupData2]);
      matchupsRepo.updatePoints.mockResolvedValue(mockMatchup);
      matchupsRepo.finalize.mockResolvedValue(mockMatchup);

      await service.finalizeWeekMatchups(LEAGUE_ID, WEEK, COMMISSIONER_ID);

      expect(leagueRepo.isCommissioner).toHaveBeenCalledWith(LEAGUE_ID, COMMISSIONER_ID);
      expect(scoringService.calculateWeeklyScores).toHaveBeenCalledWith(LEAGUE_ID, WEEK, COMMISSIONER_ID);
      expect(matchupsRepo.updatePoints).toHaveBeenCalledWith(
        MATCHUP_ID,
        105.5,
        98.3,
        expect.anything()
      );
      expect(matchupsRepo.finalize).toHaveBeenCalledWith(MATCHUP_ID, expect.anything());
    });

    it('should throw ForbiddenException when user is not commissioner', async () => {
      leagueRepo.isCommissioner.mockResolvedValue(false);

      await expect(
        service.finalizeWeekMatchups(LEAGUE_ID, WEEK, USER_ID)
      ).rejects.toThrow(ForbiddenException);
      await expect(
        service.finalizeWeekMatchups(LEAGUE_ID, WEEK, USER_ID)
      ).rejects.toThrow('Only the commissioner can finalize matchups');
    });

    it('should throw BadRequestException when NFL games are still in progress', async () => {
      leagueRepo.isCommissioner.mockResolvedValue(true);
      leagueRepo.findById.mockResolvedValue(mockLeague);
      matchupsRepo.getMaxScheduledWeek.mockResolvedValue(17);
      gameProgressService.hasGamesInProgress.mockResolvedValue(true);

      await expect(
        service.finalizeWeekMatchups(LEAGUE_ID, WEEK, COMMISSIONER_ID)
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.finalizeWeekMatchups(LEAGUE_ID, WEEK, COMMISSIONER_ID)
      ).rejects.toThrow('Cannot finalize week while NFL games are still in progress');
    });

    it('should throw ValidationException when week exceeds max scheduled week', async () => {
      leagueRepo.isCommissioner.mockResolvedValue(true);
      leagueRepo.findById.mockResolvedValue(mockLeague);
      matchupsRepo.getMaxScheduledWeek.mockResolvedValue(14);

      await expect(
        service.finalizeWeekMatchups(LEAGUE_ID, 15, COMMISSIONER_ID)
      ).rejects.toThrow(ValidationException);
      await expect(
        service.finalizeWeekMatchups(LEAGUE_ID, 15, COMMISSIONER_ID)
      ).rejects.toThrow('Week 15 is beyond the scheduled weeks (max: 14)');
    });

    it('should throw ValidationException when no matchups are scheduled', async () => {
      leagueRepo.isCommissioner.mockResolvedValue(true);
      leagueRepo.findById.mockResolvedValue(mockLeague);
      matchupsRepo.getMaxScheduledWeek.mockResolvedValue(null);

      await expect(
        service.finalizeWeekMatchups(LEAGUE_ID, WEEK, COMMISSIONER_ID)
      ).rejects.toThrow(ValidationException);
      await expect(
        service.finalizeWeekMatchups(LEAGUE_ID, WEEK, COMMISSIONER_ID)
      ).rejects.toThrow('No matchups have been scheduled for this league');
    });

    it('should throw NotFoundException when league does not exist', async () => {
      leagueRepo.isCommissioner.mockResolvedValue(true);
      leagueRepo.findById.mockResolvedValue(null);

      await expect(
        service.finalizeWeekMatchups(LEAGUE_ID, WEEK, COMMISSIONER_ID)
      ).rejects.toThrow(NotFoundException);
    });

    it('should invoke median service when useLeagueMedian is enabled and not playoff', async () => {
      const medianLeague = new League(
        LEAGUE_ID,
        'Test League',
        'active',
        {},
        {},
        String(SEASON),
        10,
        new Date(),
        new Date(),
        undefined,
        undefined,
        'redraft',
        { useLeagueMedian: true },
        WEEK,
        'regular_season'
      );

      leagueRepo.isCommissioner.mockResolvedValue(true);
      leagueRepo.findById.mockResolvedValue(medianLeague);
      matchupsRepo.getMaxScheduledWeek.mockResolvedValue(17);
      gameProgressService.hasGamesInProgress.mockResolvedValue(false);
      scoringService.calculateWeeklyScores.mockResolvedValue(undefined);

      // Non-playoff matchup
      const regularMatchup = { ...mockMatchup, isPlayoff: false };
      matchupsRepo.findByLeagueAndWeek.mockResolvedValue([regularMatchup]);

      const lineup1 = createMockLineup(ROSTER_1_ID, { QB: [], RB: [], BN: [] });
      lineup1.totalPoints = 100;
      const lineup2 = createMockLineup(ROSTER_2_ID, { QB: [], RB: [], BN: [] });
      lineup2.totalPoints = 90;
      lineupsRepo.getByLeagueAndWeek.mockResolvedValue([lineup1, lineup2]);

      matchupsRepo.updatePoints.mockResolvedValue(regularMatchup);
      matchupsRepo.finalize.mockResolvedValue(regularMatchup);

      await service.finalizeWeekMatchups(LEAGUE_ID, WEEK, COMMISSIONER_ID);

      expect(medianService.calculateAndStoreMedianResults).toHaveBeenCalledWith(
        expect.anything(), // client
        LEAGUE_ID,
        SEASON,
        WEEK
      );
    });

    it('should skip median service during playoff weeks', async () => {
      const medianLeague = new League(
        LEAGUE_ID,
        'Test League',
        'active',
        {},
        {},
        String(SEASON),
        10,
        new Date(),
        new Date(),
        undefined,
        undefined,
        'redraft',
        { useLeagueMedian: true },
        WEEK,
        'regular_season'
      );

      leagueRepo.isCommissioner.mockResolvedValue(true);
      leagueRepo.findById.mockResolvedValue(medianLeague);
      matchupsRepo.getMaxScheduledWeek.mockResolvedValue(17);
      gameProgressService.hasGamesInProgress.mockResolvedValue(false);
      scoringService.calculateWeeklyScores.mockResolvedValue(undefined);

      // Playoff matchup
      const playoffMatchup = { ...mockMatchup, isPlayoff: true };
      matchupsRepo.findByLeagueAndWeek.mockResolvedValue([playoffMatchup]);

      const lineup1 = createMockLineup(ROSTER_1_ID, { QB: [], RB: [], BN: [] });
      lineup1.totalPoints = 100;
      const lineup2 = createMockLineup(ROSTER_2_ID, { QB: [], RB: [], BN: [] });
      lineup2.totalPoints = 90;
      lineupsRepo.getByLeagueAndWeek.mockResolvedValue([lineup1, lineup2]);

      matchupsRepo.updatePoints.mockResolvedValue(playoffMatchup);
      matchupsRepo.finalize.mockResolvedValue(playoffMatchup);

      await service.finalizeWeekMatchups(LEAGUE_ID, WEEK, COMMISSIONER_ID);

      expect(medianService.calculateAndStoreMedianResults).not.toHaveBeenCalled();
    });
  });
});
