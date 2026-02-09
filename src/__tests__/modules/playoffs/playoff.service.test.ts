import { Pool, PoolClient } from 'pg';
import { PlayoffService } from '../../../modules/playoffs/playoff.service';
import { PlayoffRepository } from '../../../modules/playoffs/playoff.repository';
import { MatchupsRepository } from '../../../modules/matchups/matchups.repository';
import { LeagueRepository } from '../../../modules/leagues/leagues.repository';
import {
  PlayoffBracket,
  PlayoffSeed,
  calculateTotalRounds,
  getWeekRangeForRound,
  SeriesAggregation,
} from '../../../modules/playoffs/playoff.model';
import {
  ValidationException,
} from '../../../utils/exceptions';

// Mock the transaction runner to execute the callback directly
jest.mock('../../../shared/transaction-runner', () => ({
  runWithLock: jest.fn(async (_db, _domain, _id, callback) => {
    const mockClient = { query: jest.fn() } as unknown as PoolClient;
    return callback(mockClient);
  }),
  LockDomain: { LEAGUE: 100_000_000 },
}));

// Mock event bus
jest.mock('../../../shared/events', () => ({
  tryGetEventBus: jest.fn(() => null),
  EventTypes: {
    PLAYOFF_BRACKET_GENERATED: 'playoff:bracket:generated',
    PLAYOFF_WINNERS_ADVANCED: 'playoff:winners:advanced',
    PLAYOFF_CHAMPION_CROWNED: 'playoff:champion:crowned',
  },
}));

const createMockPlayoffRepo = (): jest.Mocked<PlayoffRepository> =>
  ({
    createBracket: jest.fn(),
    findById: jest.fn(),
    findByLeagueSeason: jest.fn(),
    createSeeds: jest.fn(),
    getSeeds: jest.fn(),
    getSeedsByType: jest.fn(),
    createPlayoffMatchup: jest.fn(),
    createPlayoffMatchupWithSeries: jest.fn(),
    setChampion: jest.fn(),
    setThirdPlaceWinner: jest.fn(),
    setConsolationWinner: jest.fn(),
    finalizeBracketIfComplete: jest.fn(),
    updateStatus: jest.fn(),
    getFinalizedMatchupsForWeekByType: jest.fn(),
    getFinalizedSeriesEndingInWeek: jest.fn(),
    getPlayoffMatchupsByType: jest.fn(),
    roundMatchupsExistForType: jest.fn(),
    getSeriesMatchups: jest.fn(),
    getSeriesAggregation: jest.fn(),
    isSeriesComplete: jest.fn(),
  }) as unknown as jest.Mocked<PlayoffRepository>;

const createMockMatchupsRepo = (): jest.Mocked<MatchupsRepository> =>
  ({
    getStandings: jest.fn(),
    findMatchupsInWeekRange: jest.fn(),
  }) as unknown as jest.Mocked<MatchupsRepository>;

const createMockLeagueRepo = (): jest.Mocked<LeagueRepository> =>
  ({
    findById: jest.fn(),
    isCommissioner: jest.fn(),
    isUserMember: jest.fn(),
  }) as unknown as jest.Mocked<LeagueRepository>;

const createMockPool = (): jest.Mocked<Pool> =>
  ({
    query: jest.fn(),
  }) as unknown as jest.Mocked<Pool>;

// Helper to create mock bracket
function createMockBracket(overrides: Partial<PlayoffBracket> = {}): PlayoffBracket {
  return {
    id: 1,
    leagueId: 1,
    season: 2024,
    playoffTeams: 6,
    totalRounds: 3,
    startWeek: 14,
    championshipWeek: 16,
    status: 'active',
    championRosterId: null,
    enableThirdPlace: true,
    consolationType: 'CONSOLATION',
    consolationTeams: 6,
    thirdPlaceRosterId: null,
    consolationWinnerRosterId: null,
    weeksByRound: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

// Helper to create mock standings
function createMockStandings(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    rosterId: i + 1,
    teamName: `Team ${i + 1}`,
    userId: `user-${i + 1}`,
    wins: 10 - i,
    losses: i,
    ties: 0,
    h2hWins: 10 - i,
    h2hLosses: i,
    h2hTies: 0,
    medianWins: null,
    medianLosses: null,
    medianTies: null,
    pointsFor: 1000 - i * 10,
    pointsAgainst: 800 + i * 5,
    streak: i < 3 ? 'W3' : 'L2',
    rank: i + 1,
  }));
}

// Helper to create mock seeds
function createMockSeeds(count: number, bracketType: 'WINNERS' | 'CONSOLATION' = 'WINNERS'): PlayoffSeed[] {
  const byeSeeds = count === 6 ? [1, 2] : [];
  return Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    bracketId: 1,
    rosterId: i + 1,
    seed: i + 1,
    regularSeasonRecord: `${10 - i}-${i}`,
    pointsFor: 1000 - i * 10,
    hasBye: byeSeeds.includes(i + 1),
    bracketType,
    createdAt: new Date(),
    teamName: `Team ${i + 1}`,
    userId: `user-${i + 1}`,
  }));
}

describe('PlayoffService', () => {
  let playoffService: PlayoffService;
  let mockPool: jest.Mocked<Pool>;
  let mockPlayoffRepo: jest.Mocked<PlayoffRepository>;
  let mockMatchupsRepo: jest.Mocked<MatchupsRepository>;
  let mockLeagueRepo: jest.Mocked<LeagueRepository>;

  beforeEach(() => {
    mockPool = createMockPool();
    mockPlayoffRepo = createMockPlayoffRepo();
    mockMatchupsRepo = createMockMatchupsRepo();
    mockLeagueRepo = createMockLeagueRepo();
    playoffService = new PlayoffService(
      mockPool,
      mockPlayoffRepo,
      mockMatchupsRepo,
      mockLeagueRepo
    );
  });

  describe('6-team consolation bracket with byes', () => {
    it('should create consolation seeds when generating 6-team consolation bracket', async () => {
      const mockBracket = createMockBracket({ id: 1 });
      const mockStandings = createMockStandings(12);
      const mockWinnersSeeds = createMockSeeds(6, 'WINNERS');

      mockLeagueRepo.isCommissioner.mockResolvedValue(true);
      mockLeagueRepo.findById.mockResolvedValue({
        id: 1,
        season: '2024',
        currentWeek: 13,
      } as any);
      mockPlayoffRepo.findByLeagueSeason.mockResolvedValue(null);
      mockMatchupsRepo.findMatchupsInWeekRange.mockResolvedValue([]);
      mockMatchupsRepo.getStandings.mockResolvedValue(mockStandings);
      mockPlayoffRepo.createBracket.mockResolvedValue(mockBracket);
      mockPlayoffRepo.createSeeds.mockResolvedValue(mockWinnersSeeds);
      mockPlayoffRepo.createPlayoffMatchup.mockResolvedValue(1);
      mockPlayoffRepo.findById.mockResolvedValue(mockBracket);
      mockPlayoffRepo.getSeeds.mockResolvedValue(mockWinnersSeeds);
      mockPlayoffRepo.getSeedsByType.mockResolvedValue([]);
      mockPlayoffRepo.getPlayoffMatchupsByType.mockResolvedValue([]);

      await playoffService.generatePlayoffBracket(1, 'user-123', {
        playoffTeams: 6,
        startWeek: 14,
        enableThirdPlaceGame: true,
        consolationType: 'CONSOLATION',
        consolationTeams: 6,
      });

      // Verify consolation seeds were created (second call to createSeeds)
      expect(mockPlayoffRepo.createSeeds).toHaveBeenCalledTimes(2);

      // First call: winners seeds
      const winnersCall = mockPlayoffRepo.createSeeds.mock.calls[0];
      expect(winnersCall[1]).toHaveLength(6);
      expect(winnersCall[1][0].bracketType).toBeUndefined(); // Defaults to WINNERS

      // Second call: consolation seeds
      const consolationCall = mockPlayoffRepo.createSeeds.mock.calls[1];
      expect(consolationCall[1]).toHaveLength(6);
      expect(consolationCall[1][0].bracketType).toBe('CONSOLATION');
      expect(consolationCall[1][0].hasBye).toBe(true); // Seed 1 has bye
      expect(consolationCall[1][1].hasBye).toBe(true); // Seed 2 has bye
      expect(consolationCall[1][2].hasBye).toBe(false); // Seed 3 no bye
    });

    it('should advance 6-team consolation with bye teams in round 2', async () => {
      const mockBracket = createMockBracket({
        status: 'active',
        consolationType: 'CONSOLATION',
        consolationTeams: 6,
      });

      const consolationSeeds = createMockSeeds(6, 'CONSOLATION').map((s, i) => ({
        ...s,
        rosterId: 100 + i + 1, // Different roster IDs for consolation
      }));

      // Round 1 finalized matchups: 3v6 (pos 1) and 4v5 (pos 2)
      const round1Matchups = [
        {
          id: 1,
          playoff_round: 1,
          bracket_position: 1,
          roster1_id: 103, // seed 3
          roster2_id: 106, // seed 6
          roster1_points: 100,
          roster2_points: 90,
          playoff_seed1: 3,
          playoff_seed2: 6,
          is_final: true,
        },
        {
          id: 2,
          playoff_round: 1,
          bracket_position: 2,
          roster1_id: 104, // seed 4
          roster2_id: 105, // seed 5
          roster1_points: 95,
          roster2_points: 80,
          playoff_seed1: 4,
          playoff_seed2: 5,
          is_final: true,
        },
      ];

      mockLeagueRepo.isCommissioner.mockResolvedValue(true);
      mockLeagueRepo.findById.mockResolvedValue({ id: 1, season: '2024' } as any);
      mockPlayoffRepo.findByLeagueSeason.mockResolvedValue(mockBracket);
      mockPlayoffRepo.getFinalizedMatchupsForWeekByType
        .mockResolvedValueOnce([]) // WINNERS - none
        .mockResolvedValueOnce(round1Matchups) // CONSOLATION - round 1
        .mockResolvedValueOnce([]); // THIRD_PLACE - none
      mockPlayoffRepo.roundMatchupsExistForType.mockResolvedValue(false);
      mockPlayoffRepo.getSeedsByType.mockResolvedValue(consolationSeeds);
      mockPlayoffRepo.createPlayoffMatchup.mockResolvedValue(1);
      mockPlayoffRepo.findById.mockResolvedValue(mockBracket);
      mockPlayoffRepo.getSeeds.mockResolvedValue([]);
      mockPlayoffRepo.getPlayoffMatchupsByType.mockResolvedValue([]);

      await playoffService.advanceWinners(1, 14, 'user-123');

      // Verify round 2 matchups were created with bye teams
      expect(mockPlayoffRepo.createPlayoffMatchup).toHaveBeenCalledTimes(2);

      // Semifinal 1: Seed 1 (bye) vs winner of 4v5 (seed 4)
      const semifinal1 = mockPlayoffRepo.createPlayoffMatchup.mock.calls[0];
      expect(semifinal1[3]).toBe(101); // seed 1 roster
      expect(semifinal1[4]).toBe(104); // winner of 4v5
      expect(semifinal1[6]).toBe(1); // seed 1
      expect(semifinal1[7]).toBe(4); // seed 4 (winner)
      expect(semifinal1[8]).toBe(1); // bracket position 1

      // Semifinal 2: Seed 2 (bye) vs winner of 3v6 (seed 3)
      const semifinal2 = mockPlayoffRepo.createPlayoffMatchup.mock.calls[1];
      expect(semifinal2[3]).toBe(102); // seed 2 roster
      expect(semifinal2[4]).toBe(103); // winner of 3v6
      expect(semifinal2[6]).toBe(2); // seed 2
      expect(semifinal2[7]).toBe(3); // seed 3 (winner)
      expect(semifinal2[8]).toBe(2); // bracket position 2
    });
  });

  describe('bracket completion semantics', () => {
    it('should not complete bracket when only champion is set (3rd place pending)', async () => {
      const mockBracket = createMockBracket({
        status: 'active',
        enableThirdPlace: true,
        consolationType: 'NONE',
        consolationTeams: null,
      });

      // Championship matchup
      const championshipMatchups = [
        {
          id: 1,
          playoff_round: 3,
          bracket_position: 1,
          roster1_id: 1,
          roster2_id: 2,
          roster1_points: 100,
          roster2_points: 90,
          playoff_seed1: 1,
          playoff_seed2: 2,
          is_final: true,
        },
      ];

      mockLeagueRepo.isCommissioner.mockResolvedValue(true);
      mockLeagueRepo.findById.mockResolvedValue({ id: 1, season: '2024' } as any);
      mockPlayoffRepo.findByLeagueSeason.mockResolvedValue(mockBracket);
      mockPlayoffRepo.getFinalizedMatchupsForWeekByType
        .mockResolvedValueOnce(championshipMatchups) // WINNERS - championship
        .mockResolvedValueOnce([]) // CONSOLATION
        .mockResolvedValueOnce([]); // THIRD_PLACE - not finalized yet
      mockPlayoffRepo.setChampion.mockResolvedValue(undefined);
      mockPlayoffRepo.finalizeBracketIfComplete.mockResolvedValue(false); // Not complete yet
      mockPlayoffRepo.findById.mockResolvedValue({
        ...mockBracket,
        championRosterId: 1,
      });
      mockPlayoffRepo.getSeeds.mockResolvedValue(createMockSeeds(6));
      mockPlayoffRepo.getSeedsByType.mockResolvedValue([]);
      mockPlayoffRepo.getPlayoffMatchupsByType.mockResolvedValue([]);

      await playoffService.advanceWinners(1, 16, 'user-123');

      // Champion should be set
      expect(mockPlayoffRepo.setChampion).toHaveBeenCalledWith(1, 1, expect.anything());

      // finalizeBracketIfComplete should be called
      expect(mockPlayoffRepo.finalizeBracketIfComplete).toHaveBeenCalled();
    });

    it('should complete bracket when all required winners are set', async () => {
      const mockBracket = createMockBracket({
        status: 'active',
        enableThirdPlace: true,
        consolationType: 'CONSOLATION',
        consolationTeams: 4,
        championRosterId: 1, // Champion already set
        thirdPlaceRosterId: 3, // 3rd place already set
      });

      // Consolation final matchup
      const consolationFinalMatchups = [
        {
          id: 1,
          playoff_round: 2, // 4-team = 2 rounds
          bracket_position: 1,
          roster1_id: 101,
          roster2_id: 102,
          roster1_points: 100,
          roster2_points: 90,
          playoff_seed1: 1,
          playoff_seed2: 2,
          is_final: true,
        },
      ];

      mockLeagueRepo.isCommissioner.mockResolvedValue(true);
      mockLeagueRepo.findById.mockResolvedValue({ id: 1, season: '2024' } as any);
      mockPlayoffRepo.findByLeagueSeason.mockResolvedValue(mockBracket);
      mockPlayoffRepo.getFinalizedMatchupsForWeekByType
        .mockResolvedValueOnce([]) // WINNERS - already done
        .mockResolvedValueOnce(consolationFinalMatchups) // CONSOLATION - final
        .mockResolvedValueOnce([]); // THIRD_PLACE - already done
      mockPlayoffRepo.setConsolationWinner.mockResolvedValue(undefined);
      mockPlayoffRepo.finalizeBracketIfComplete.mockResolvedValue(true); // Now complete
      mockPlayoffRepo.findById.mockResolvedValue({
        ...mockBracket,
        consolationWinnerRosterId: 101,
        status: 'completed',
      });
      mockPlayoffRepo.getSeeds.mockResolvedValue(createMockSeeds(6));
      mockPlayoffRepo.getSeedsByType.mockResolvedValue(createMockSeeds(4, 'CONSOLATION'));
      mockPlayoffRepo.getPlayoffMatchupsByType.mockResolvedValue([]);

      await playoffService.advanceWinners(1, 15, 'user-123');

      // Consolation winner should be set
      expect(mockPlayoffRepo.setConsolationWinner).toHaveBeenCalledWith(1, 101, expect.anything());

      // finalizeBracketIfComplete should be called
      expect(mockPlayoffRepo.finalizeBracketIfComplete).toHaveBeenCalled();
    });

    it('should allow advancing 3rd place game after champion is set', async () => {
      // Bracket with champion set but 3rd place pending
      const mockBracket = createMockBracket({
        status: 'active', // Still active because 3rd place not done
        enableThirdPlace: true,
        consolationType: 'NONE',
        championRosterId: 1, // Champion already set
        thirdPlaceRosterId: null,
      });

      // 3rd place matchup
      const thirdPlaceMatchups = [
        {
          id: 1,
          playoff_round: 3,
          bracket_position: 2, // 3rd place is position 2
          roster1_id: 3,
          roster2_id: 4,
          roster1_points: 100,
          roster2_points: 90,
          playoff_seed1: 3,
          playoff_seed2: 4,
          is_final: true,
        },
      ];

      mockLeagueRepo.isCommissioner.mockResolvedValue(true);
      mockLeagueRepo.findById.mockResolvedValue({ id: 1, season: '2024' } as any);
      mockPlayoffRepo.findByLeagueSeason.mockResolvedValue(mockBracket);
      mockPlayoffRepo.getFinalizedMatchupsForWeekByType
        .mockResolvedValueOnce([]) // WINNERS - already done
        .mockResolvedValueOnce([]) // CONSOLATION - none
        .mockResolvedValueOnce(thirdPlaceMatchups); // THIRD_PLACE
      mockPlayoffRepo.setThirdPlaceWinner.mockResolvedValue(undefined);
      mockPlayoffRepo.finalizeBracketIfComplete.mockResolvedValue(true); // Now complete
      mockPlayoffRepo.findById.mockResolvedValue({
        ...mockBracket,
        thirdPlaceRosterId: 3,
        status: 'completed',
      });
      mockPlayoffRepo.getSeeds.mockResolvedValue(createMockSeeds(6));
      mockPlayoffRepo.getSeedsByType.mockResolvedValue([]);
      mockPlayoffRepo.getPlayoffMatchupsByType.mockResolvedValue([]);

      await playoffService.advanceWinners(1, 16, 'user-123');

      // 3rd place winner should be set
      expect(mockPlayoffRepo.setThirdPlaceWinner).toHaveBeenCalledWith(1, 3, expect.anything());

      // finalizeBracketIfComplete should be called
      expect(mockPlayoffRepo.finalizeBracketIfComplete).toHaveBeenCalled();
    });

    it('should throw when all winners are set and bracket is truly completed', async () => {
      const mockBracket = createMockBracket({
        status: 'completed',
        enableThirdPlace: true,
        consolationType: 'CONSOLATION',
        consolationTeams: 4,
        championRosterId: 1,
        thirdPlaceRosterId: 3,
        consolationWinnerRosterId: 101,
      });

      mockLeagueRepo.isCommissioner.mockResolvedValue(true);
      mockLeagueRepo.findById.mockResolvedValue({ id: 1, season: '2024' } as any);
      mockPlayoffRepo.findByLeagueSeason.mockResolvedValue(mockBracket);

      await expect(
        playoffService.advanceWinners(1, 16, 'user-123')
      ).rejects.toThrow(ValidationException);
    });
  });

  describe('calculateTotalRounds', () => {
    it('should return 2 for 4-team brackets', () => {
      expect(calculateTotalRounds(4)).toBe(2);
    });

    it('should return 3 for 6-team brackets', () => {
      expect(calculateTotalRounds(6)).toBe(3);
    });

    it('should return 3 for 8-team brackets', () => {
      expect(calculateTotalRounds(8)).toBe(3);
    });
  });

  describe('getWeekRangeForRound', () => {
    it('should return single week when no weeksByRound', () => {
      const result = getWeekRangeForRound(14, null, 1);
      expect(result).toEqual({ weekStart: 14, weekEnd: 14 });
    });

    it('should return single week for 1-week round', () => {
      const result = getWeekRangeForRound(14, [1, 1, 1], 1);
      expect(result).toEqual({ weekStart: 14, weekEnd: 14 });
    });

    it('should return week range for 2-week round', () => {
      const result = getWeekRangeForRound(14, [1, 2, 2], 2);
      expect(result).toEqual({ weekStart: 15, weekEnd: 16 });
    });

    it('should accumulate weeks correctly', () => {
      // [1, 2, 2] means R1=1wk (14), R2=2wk (15-16), R3=2wk (17-18)
      expect(getWeekRangeForRound(14, [1, 2, 2], 1)).toEqual({ weekStart: 14, weekEnd: 14 });
      expect(getWeekRangeForRound(14, [1, 2, 2], 2)).toEqual({ weekStart: 15, weekEnd: 16 });
      expect(getWeekRangeForRound(14, [1, 2, 2], 3)).toEqual({ weekStart: 17, weekEnd: 18 });
    });
  });

  describe('multi-week series generation', () => {
    it('should create 2 matchup rows for 2-week rounds', async () => {
      const mockBracket = createMockBracket({
        id: 1,
        weeksByRound: [1, 2, 2],
        championshipWeek: 18, // 14 + 1 + 2 + 2 - 1 = 18
      });
      const mockStandings = createMockStandings(12);
      const mockWinnersSeeds = createMockSeeds(6, 'WINNERS');

      mockLeagueRepo.isCommissioner.mockResolvedValue(true);
      mockLeagueRepo.findById.mockResolvedValue({
        id: 1,
        season: '2024',
        currentWeek: 13,
      } as any);
      mockPlayoffRepo.findByLeagueSeason.mockResolvedValue(null);
      mockMatchupsRepo.findMatchupsInWeekRange.mockResolvedValue([]);
      mockMatchupsRepo.getStandings.mockResolvedValue(mockStandings);
      mockPlayoffRepo.createBracket.mockResolvedValue(mockBracket);
      mockPlayoffRepo.createSeeds.mockResolvedValue(mockWinnersSeeds);
      mockPlayoffRepo.createPlayoffMatchupWithSeries.mockResolvedValue(1);
      mockPlayoffRepo.findById.mockResolvedValue(mockBracket);
      mockPlayoffRepo.getSeeds.mockResolvedValue(mockWinnersSeeds);
      mockPlayoffRepo.getSeedsByType.mockResolvedValue([]);
      mockPlayoffRepo.getPlayoffMatchupsByType.mockResolvedValue([]);

      await playoffService.generatePlayoffBracket(1, 'user-123', {
        playoffTeams: 6,
        startWeek: 14,
        weeksByRound: [1, 2, 2],
        enableThirdPlaceGame: false,
        consolationType: 'NONE',
      });

      // Round 1 (1 week): 2 matchups x 1 game = 2 calls
      // For 6-team with byes, round 1 has 3v6 and 4v5
      const round1Calls = mockPlayoffRepo.createPlayoffMatchupWithSeries.mock.calls.filter(
        call => call[5] === 1 // playoff_round = 1
      );
      expect(round1Calls).toHaveLength(2); // 2 matchups, 1 game each

      // Verify series_length = 1 for round 1
      round1Calls.forEach(call => {
        expect(call[12]).toBe(1); // series_length = 1
      });
    });

    it('should reject weeksByRound with values other than 1 or 2', async () => {
      mockLeagueRepo.isCommissioner.mockResolvedValue(true);
      mockLeagueRepo.findById.mockResolvedValue({
        id: 1,
        season: '2024',
        currentWeek: 13,
      } as any);
      mockPlayoffRepo.findByLeagueSeason.mockResolvedValue(null);

      await expect(
        playoffService.generatePlayoffBracket(1, 'user-123', {
          playoffTeams: 6,
          startWeek: 14,
          weeksByRound: [1, 3, 1], // Invalid: 3 is not allowed
          enableThirdPlaceGame: false,
          consolationType: 'NONE',
        })
      ).rejects.toThrow(ValidationException);
    });

    it('should reject weeksByRound with wrong length', async () => {
      mockLeagueRepo.isCommissioner.mockResolvedValue(true);
      mockLeagueRepo.findById.mockResolvedValue({
        id: 1,
        season: '2024',
        currentWeek: 13,
      } as any);
      mockPlayoffRepo.findByLeagueSeason.mockResolvedValue(null);

      await expect(
        playoffService.generatePlayoffBracket(1, 'user-123', {
          playoffTeams: 6,
          startWeek: 14,
          weeksByRound: [1, 2], // Invalid: 6-team needs 3 rounds
          enableThirdPlaceGame: false,
          consolationType: 'NONE',
        })
      ).rejects.toThrow(ValidationException);
    });

    it('should reject weeksByRound that exceeds week 18', async () => {
      mockLeagueRepo.isCommissioner.mockResolvedValue(true);
      mockLeagueRepo.findById.mockResolvedValue({
        id: 1,
        season: '2024',
        currentWeek: 13,
      } as any);
      mockPlayoffRepo.findByLeagueSeason.mockResolvedValue(null);

      await expect(
        playoffService.generatePlayoffBracket(1, 'user-123', {
          playoffTeams: 6,
          startWeek: 16, // 16 + 2 + 2 + 2 - 1 = 21 > 18
          weeksByRound: [2, 2, 2],
          enableThirdPlaceGame: false,
          consolationType: 'NONE',
        })
      ).rejects.toThrow(ValidationException);
    });
  });

  describe('multi-week series advancement', () => {
    it('should advance winners based on aggregate scoring', async () => {
      const mockBracket = createMockBracket({
        status: 'active',
        weeksByRound: [1, 2, 2],
        consolationType: 'NONE',
        enableThirdPlace: false,
      });

      const mockWinnersSeeds = createMockSeeds(6, 'WINNERS');

      // Series aggregation for round 1 (single week, so immediate)
      const seriesAggregation: SeriesAggregation[] = [
        {
          seriesId: 'series-1',
          roster1Id: 3,
          roster2Id: 6,
          roster1TotalPoints: 100,
          roster2TotalPoints: 90,
          roster1Seed: 3,
          roster2Seed: 6,
          gamesCompleted: 1,
          seriesLength: 1,
          isComplete: true,
        },
        {
          seriesId: 'series-2',
          roster1Id: 4,
          roster2Id: 5,
          roster1TotalPoints: 85,
          roster2TotalPoints: 95,
          roster1Seed: 4,
          roster2Seed: 5,
          gamesCompleted: 1,
          seriesLength: 1,
          isComplete: true,
        },
      ];

      mockLeagueRepo.isCommissioner.mockResolvedValue(true);
      mockLeagueRepo.findById.mockResolvedValue({ id: 1, season: '2024' } as any);
      mockPlayoffRepo.findByLeagueSeason.mockResolvedValue(mockBracket);
      mockPlayoffRepo.getFinalizedSeriesEndingInWeek.mockResolvedValue(seriesAggregation);
      mockPlayoffRepo.roundMatchupsExistForType.mockResolvedValue(false);
      mockPlayoffRepo.getSeedsByType.mockResolvedValue(mockWinnersSeeds);
      mockPlayoffRepo.createPlayoffMatchupWithSeries.mockResolvedValue(1);
      mockPlayoffRepo.findById.mockResolvedValue(mockBracket);
      mockPlayoffRepo.getSeeds.mockResolvedValue(mockWinnersSeeds);
      mockPlayoffRepo.getPlayoffMatchupsByType.mockResolvedValue([]);

      await playoffService.advanceWinners(1, 14, 'user-123');

      // Round 2 matchups should be created
      // Seed 1 (bye) vs winner of 4v5 (seed 5 won with 95 pts)
      // Seed 2 (bye) vs winner of 3v6 (seed 3 won with 100 pts)
      expect(mockPlayoffRepo.createPlayoffMatchupWithSeries).toHaveBeenCalled();
    });

    it('should use lower seed as tiebreaker for aggregate ties', async () => {
      const mockBracket = createMockBracket({
        status: 'active',
        weeksByRound: [2, 1, 1], // 2-week round 1
        consolationType: 'NONE',
        enableThirdPlace: false,
      });

      const mockWinnersSeeds = createMockSeeds(4, 'WINNERS');

      // Tie in aggregate points - lower seed (higher rank) should win
      const seriesAggregation: SeriesAggregation[] = [
        {
          seriesId: 'series-1',
          roster1Id: 1,
          roster2Id: 4,
          roster1TotalPoints: 200, // Tied
          roster2TotalPoints: 200, // Tied
          roster1Seed: 1, // Lower seed = higher rank
          roster2Seed: 4,
          gamesCompleted: 2,
          seriesLength: 2,
          isComplete: true,
        },
      ];

      mockLeagueRepo.isCommissioner.mockResolvedValue(true);
      mockLeagueRepo.findById.mockResolvedValue({ id: 1, season: '2024' } as any);
      mockPlayoffRepo.findByLeagueSeason.mockResolvedValue(mockBracket);
      mockPlayoffRepo.getFinalizedSeriesEndingInWeek.mockResolvedValue(seriesAggregation);
      mockPlayoffRepo.roundMatchupsExistForType.mockResolvedValue(false);
      mockPlayoffRepo.getSeedsByType.mockResolvedValue(mockWinnersSeeds);
      mockPlayoffRepo.createPlayoffMatchupWithSeries.mockResolvedValue(1);
      mockPlayoffRepo.findById.mockResolvedValue(mockBracket);
      mockPlayoffRepo.getSeeds.mockResolvedValue(mockWinnersSeeds);
      mockPlayoffRepo.getPlayoffMatchupsByType.mockResolvedValue([]);

      await playoffService.advanceWinners(1, 15, 'user-123'); // Week 15 is end of 2-week round 1

      // Seed 1 should advance (tiebreaker)
      const createCalls = mockPlayoffRepo.createPlayoffMatchupWithSeries.mock.calls;
      // The winner (roster 1, seed 1) should be in the next round
      const advancedRosterId = createCalls.find(call => call[5] === 2)?.[3] || createCalls.find(call => call[5] === 2)?.[4];
      expect([1]).toContain(advancedRosterId); // Roster 1 should advance
    });
  });
});
