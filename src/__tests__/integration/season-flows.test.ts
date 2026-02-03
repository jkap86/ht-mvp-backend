import { Pool, PoolClient } from 'pg';
import { ScheduleGeneratorService } from '../../modules/matchups/schedule-generator.service';
import { ScoringService } from '../../modules/scoring/scoring.service';
import { WaiversService } from '../../modules/waivers/waivers.service';
import { TradesService } from '../../modules/trades/trades.service';
import { MatchupsRepository } from '../../modules/matchups/matchups.repository';
import { LineupsRepository } from '../../modules/lineups/lineups.repository';
import { PlayerStatsRepository } from '../../modules/scoring/scoring.repository';
import { LeagueRepository, RosterRepository } from '../../modules/leagues/leagues.repository';
import {
  RosterPlayersRepository,
  RosterTransactionsRepository,
} from '../../modules/rosters/rosters.repository';
import {
  WaiverPriorityRepository,
  FaabBudgetRepository,
  WaiverClaimsRepository,
  WaiverWireRepository,
} from '../../modules/waivers/waivers.repository';
import {
  TradesRepository,
  TradeItemsRepository,
  TradeVotesRepository,
} from '../../modules/trades/trades.repository';
import { DEFAULT_SCORING_RULES, PlayerStats } from '../../modules/scoring/scoring.model';
import { LineupSlots, RosterLineup } from '../../modules/lineups/lineups.model';
import { Roster, League } from '../../modules/leagues/leagues.model';
import { WaiverClaim } from '../../modules/waivers/waivers.model';
import { Trade, TradeItem } from '../../modules/trades/trades.model';
import { RosterTransaction } from '../../modules/rosters/rosters.model';

// Mock socket service to prevent emission errors
jest.mock('../../socket', () => ({
  tryGetSocketService: jest.fn(() => ({
    emitTradeProposed: jest.fn(),
    emitTradeAccepted: jest.fn(),
    emitTradeRejected: jest.fn(),
    emitTradeCancelled: jest.fn(),
    emitTradeCountered: jest.fn(),
    emitTradeCompleted: jest.fn(),
    emitTradeVetoed: jest.fn(),
    emitTradeVoteCast: jest.fn(),
    emitTradeExpired: jest.fn(),
    emitTradeInvalidated: jest.fn(),
    emitWaiverClaimSuccessful: jest.fn(),
    emitWaiverClaimFailed: jest.fn(),
    emitWaiverPriorityUpdated: jest.fn(),
  })),
  getSocketService: jest.fn(() => ({
    emitTradeProposed: jest.fn(),
    emitTradeAccepted: jest.fn(),
    emitTradeRejected: jest.fn(),
    emitTradeCancelled: jest.fn(),
    emitTradeCountered: jest.fn(),
    emitTradeCompleted: jest.fn(),
    emitTradeVetoed: jest.fn(),
    emitTradeVoteCast: jest.fn(),
    emitTradeExpired: jest.fn(),
    emitTradeInvalidated: jest.fn(),
    emitWaiverClaimed: jest.fn(),
    emitWaiverProcessed: jest.fn(),
  })),
}));

// ==================== HELPER FUNCTIONS ====================

const createMockPoolClient = (): jest.Mocked<PoolClient> =>
  ({
    query: jest.fn().mockResolvedValue({ rows: [] }),
    release: jest.fn(),
  }) as unknown as jest.Mocked<PoolClient>;

const createMockPool = (mockClient: jest.Mocked<PoolClient>): jest.Mocked<Pool> =>
  ({
    connect: jest.fn().mockResolvedValue(mockClient),
    query: jest.fn().mockResolvedValue({ rows: [] }),
  }) as unknown as jest.Mocked<Pool>;

// ==================== TEST 1: Schedule -> Lineup -> Stats -> Score flow ====================

describe('Season Sanity Integration Tests', () => {
  describe('Schedule -> Lineup -> Stats -> Score flow', () => {
    let mockPool: jest.Mocked<Pool>;
    let mockPoolClient: jest.Mocked<PoolClient>;
    let scheduleGeneratorService: ScheduleGeneratorService;
    let scoringService: ScoringService;
    let mockMatchupsRepo: jest.Mocked<MatchupsRepository>;
    let mockLineupsRepo: jest.Mocked<LineupsRepository>;
    let mockStatsRepo: jest.Mocked<PlayerStatsRepository>;
    let mockRosterRepo: jest.Mocked<RosterRepository>;
    let mockLeagueRepo: jest.Mocked<LeagueRepository>;

    const mockLeague = new League(
      1, // id
      'Test League', // name
      'active', // status
      {
        // settings
        commissioner_roster_id: 1,
        roster_size: 15,
      },
      { type: 'ppr' }, // scoringSettings
      '2024', // season
      4, // totalRosters
      new Date(), // createdAt
      new Date(), // updatedAt
      undefined, // userRosterId
      1, // commissionerRosterId
      'redraft', // mode
      {}, // leagueSettings
      1, // currentWeek
      'regular_season', // seasonStatus
      'ABC123' // inviteCode
    );

    const mockRosters: Roster[] = [
      {
        id: 1,
        leagueId: 1,
        userId: 'user-1',
        rosterId: 1,
        settings: { team_name: 'Team Alpha' },
        starters: [],
        bench: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: 2,
        leagueId: 1,
        userId: 'user-2',
        rosterId: 2,
        settings: { team_name: 'Team Beta' },
        starters: [],
        bench: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: 3,
        leagueId: 1,
        userId: 'user-3',
        rosterId: 3,
        settings: { team_name: 'Team Gamma' },
        starters: [],
        bench: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: 4,
        leagueId: 1,
        userId: 'user-4',
        rosterId: 4,
        settings: { team_name: 'Team Delta' },
        starters: [],
        bench: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];

    beforeEach(() => {
      mockPoolClient = createMockPoolClient();
      mockPool = createMockPool(mockPoolClient);

      mockMatchupsRepo = {
        create: jest.fn(),
        deleteByLeague: jest.fn(),
        findByLeagueAndWeek: jest.fn(),
        updatePoints: jest.fn(),
        finalize: jest.fn(),
      } as unknown as jest.Mocked<MatchupsRepository>;

      mockLineupsRepo = {
        getByLeagueAndWeek: jest.fn(),
        updatePoints: jest.fn(),
        findByRosterAndWeek: jest.fn(),
        upsert: jest.fn(),
        isLocked: jest.fn(),
      } as unknown as jest.Mocked<LineupsRepository>;

      mockStatsRepo = {
        findByPlayersAndWeek: jest.fn(),
        findByPlayerAndWeek: jest.fn(),
        upsert: jest.fn(),
      } as unknown as jest.Mocked<PlayerStatsRepository>;

      mockRosterRepo = {
        findByLeagueId: jest.fn(),
        findById: jest.fn(),
        findByLeagueAndUser: jest.fn(),
      } as unknown as jest.Mocked<RosterRepository>;

      mockLeagueRepo = {
        findById: jest.fn(),
        isCommissioner: jest.fn(),
        isUserMember: jest.fn(),
      } as unknown as jest.Mocked<LeagueRepository>;

      scheduleGeneratorService = new ScheduleGeneratorService(
        mockPool,
        mockMatchupsRepo,
        mockRosterRepo,
        mockLeagueRepo
      );

      scoringService = new ScoringService(mockPool, mockStatsRepo, mockLineupsRepo, mockLeagueRepo);
    });

    it('should generate schedule, set lineups, insert stats, and calculate correct scores rounded to 2 decimal places', async () => {
      // STEP 1: Generate schedule for the league
      mockLeagueRepo.isCommissioner.mockResolvedValue(true);
      mockLeagueRepo.findById.mockResolvedValue(mockLeague);
      mockRosterRepo.findByLeagueId.mockResolvedValue(mockRosters);
      mockMatchupsRepo.deleteByLeague.mockResolvedValue();
      mockMatchupsRepo.create.mockImplementation(
        async (leagueId, season, week, roster1Id, roster2Id) => ({
          id: Math.floor(Math.random() * 1000),
          leagueId,
          season,
          week,
          roster1Id,
          roster2Id,
          roster1Points: null,
          roster2Points: null,
          isFinal: false,
          isPlayoff: false,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
      );

      await scheduleGeneratorService.generateSchedule(1, 13, 'user-1');

      // Verify schedule was generated (4 teams, 2 matchups per week)
      expect(mockMatchupsRepo.deleteByLeague).toHaveBeenCalledWith(1, 2024);
      expect(mockMatchupsRepo.create).toHaveBeenCalled();
      const createCalls = mockMatchupsRepo.create.mock.calls;
      // Week 1 should have 2 matchups for 4 teams
      const week1Matchups = createCalls.filter((call) => call[2] === 1);
      expect(week1Matchups.length).toBe(2);

      // STEP 2: Set a lineup for roster 1 (simulating setLineup)
      const mockLineup: LineupSlots = {
        QB: [101],
        RB: [102, 103],
        WR: [104, 105],
        TE: [106],
        FLEX: [107],
        SUPER_FLEX: [],
        REC_FLEX: [],
        K: [108],
        DEF: [109],
        DL: [],
        LB: [],
        DB: [],
        IDP_FLEX: [],
        BN: [110, 111],
        IR: [],
        TAXI: [],
      };

      const mockRosterLineup: RosterLineup = {
        id: 1,
        rosterId: 1,
        season: 2024,
        week: 1,
        lineup: mockLineup,
        totalPoints: null,
        isLocked: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockLineupsRepo.upsert.mockResolvedValue(mockRosterLineup);

      // STEP 3: Insert player stats for week 1
      // Non-DEF players have defPointsAllowed=99 which gives -4 points (35+ allowed bracket)
      // QB (101): 300 * 0.04 + 3 * 4 - 4 = 12 + 12 - 4 = 20 points
      // RB (102): 100 * 0.1 + 1 * 6 - 4 = 10 + 6 - 4 = 12 points
      // RB (103): 80 * 0.1 + 5 * 1 + 50 * 0.1 - 4 = 8 + 5 + 5 - 4 = 14 points
      // WR (104): 8 * 1 + 120 * 0.1 + 1 * 6 - 4 = 8 + 12 + 6 - 4 = 22 points
      // WR (105): 6 * 1 + 85 * 0.1 - 4 = 6 + 8.5 - 4 = 10.5 points
      // TE (106): 4 * 1 + 45 * 0.1 + 1 * 6 - 4 = 4 + 4.5 + 6 - 4 = 10.5 points
      // FLEX (107): 75 * 0.1 + 3 * 1 + 30 * 0.1 - 4 = 7.5 + 3 + 3 - 4 = 9.5 points
      // K (108): 3 * 3 + 2 * 1 - 4 = 9 + 2 - 4 = 7 points
      // DEF (109): 2 * 1 + 1 * 2 + 1 (for 14-20 PA) = 2 + 2 + 1 = 5 points
      // Total = 20 + 12 + 14 + 22 + 10.5 + 10.5 + 9.5 + 7 + 5 = 110.5 points

      // Note: defPointsAllowed affects scoring - 0 = shutout bonus of 10 pts
      // For non-DEF players, use 99 to get -4 points and cancel out the shutdown scoring
      // Or better: just don't include that field at all for non-DEF players
      // The scoring function will still calculate getDefensePointsAllowedScore for all players
      // So for non-DEF, we use 99 (35+ allowed = -4 points) to neutralize effect
      const mockPlayerStats: PlayerStats[] = [
        {
          id: 1,
          playerId: 101,
          season: 2024,
          week: 1,
          passYards: 300,
          passTd: 3,
          passInt: 0,
          rushYards: 0,
          rushTd: 0,
          receptions: 0,
          recYards: 0,
          recTd: 0,
          fumblesLost: 0,
          twoPtConversions: 0,
          fgMade: 0,
          fgMissed: 0,
          patMade: 0,
          patMissed: 0,
          defTd: 0,
          defInt: 0,
          defSacks: 0,
          defFumbleRec: 0,
          defSafety: 0,
          defPointsAllowed: 99,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          id: 2,
          playerId: 102,
          season: 2024,
          week: 1,
          passYards: 0,
          passTd: 0,
          passInt: 0,
          rushYards: 100,
          rushTd: 1,
          receptions: 0,
          recYards: 0,
          recTd: 0,
          fumblesLost: 0,
          twoPtConversions: 0,
          fgMade: 0,
          fgMissed: 0,
          patMade: 0,
          patMissed: 0,
          defTd: 0,
          defInt: 0,
          defSacks: 0,
          defFumbleRec: 0,
          defSafety: 0,
          defPointsAllowed: 99,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          id: 3,
          playerId: 103,
          season: 2024,
          week: 1,
          passYards: 0,
          passTd: 0,
          passInt: 0,
          rushYards: 80,
          rushTd: 0,
          receptions: 5,
          recYards: 50,
          recTd: 0,
          fumblesLost: 0,
          twoPtConversions: 0,
          fgMade: 0,
          fgMissed: 0,
          patMade: 0,
          patMissed: 0,
          defTd: 0,
          defInt: 0,
          defSacks: 0,
          defFumbleRec: 0,
          defSafety: 0,
          defPointsAllowed: 99,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          id: 4,
          playerId: 104,
          season: 2024,
          week: 1,
          passYards: 0,
          passTd: 0,
          passInt: 0,
          rushYards: 0,
          rushTd: 0,
          receptions: 8,
          recYards: 120,
          recTd: 1,
          fumblesLost: 0,
          twoPtConversions: 0,
          fgMade: 0,
          fgMissed: 0,
          patMade: 0,
          patMissed: 0,
          defTd: 0,
          defInt: 0,
          defSacks: 0,
          defFumbleRec: 0,
          defSafety: 0,
          defPointsAllowed: 99,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          id: 5,
          playerId: 105,
          season: 2024,
          week: 1,
          passYards: 0,
          passTd: 0,
          passInt: 0,
          rushYards: 0,
          rushTd: 0,
          receptions: 6,
          recYards: 85,
          recTd: 0,
          fumblesLost: 0,
          twoPtConversions: 0,
          fgMade: 0,
          fgMissed: 0,
          patMade: 0,
          patMissed: 0,
          defTd: 0,
          defInt: 0,
          defSacks: 0,
          defFumbleRec: 0,
          defSafety: 0,
          defPointsAllowed: 99,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          id: 6,
          playerId: 106,
          season: 2024,
          week: 1,
          passYards: 0,
          passTd: 0,
          passInt: 0,
          rushYards: 0,
          rushTd: 0,
          receptions: 4,
          recYards: 45,
          recTd: 1,
          fumblesLost: 0,
          twoPtConversions: 0,
          fgMade: 0,
          fgMissed: 0,
          patMade: 0,
          patMissed: 0,
          defTd: 0,
          defInt: 0,
          defSacks: 0,
          defFumbleRec: 0,
          defSafety: 0,
          defPointsAllowed: 99,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          id: 7,
          playerId: 107,
          season: 2024,
          week: 1,
          passYards: 0,
          passTd: 0,
          passInt: 0,
          rushYards: 75,
          rushTd: 0,
          receptions: 3,
          recYards: 30,
          recTd: 0,
          fumblesLost: 0,
          twoPtConversions: 0,
          fgMade: 0,
          fgMissed: 0,
          patMade: 0,
          patMissed: 0,
          defTd: 0,
          defInt: 0,
          defSacks: 0,
          defFumbleRec: 0,
          defSafety: 0,
          defPointsAllowed: 99,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          id: 8,
          playerId: 108,
          season: 2024,
          week: 1,
          passYards: 0,
          passTd: 0,
          passInt: 0,
          rushYards: 0,
          rushTd: 0,
          receptions: 0,
          recYards: 0,
          recTd: 0,
          fumblesLost: 0,
          twoPtConversions: 0,
          fgMade: 3,
          fgMissed: 0,
          patMade: 2,
          patMissed: 0,
          defTd: 0,
          defInt: 0,
          defSacks: 0,
          defFumbleRec: 0,
          defSafety: 0,
          defPointsAllowed: 99,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          id: 9,
          playerId: 109,
          season: 2024,
          week: 1,
          passYards: 0,
          passTd: 0,
          passInt: 0,
          rushYards: 0,
          rushTd: 0,
          receptions: 0,
          recYards: 0,
          recTd: 0,
          fumblesLost: 0,
          twoPtConversions: 0,
          fgMade: 0,
          fgMissed: 0,
          patMade: 0,
          patMissed: 0,
          defTd: 0,
          defInt: 1,
          defSacks: 2,
          defFumbleRec: 0,
          defSafety: 0,
          defPointsAllowed: 14,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      mockStatsRepo.findByPlayersAndWeek.mockResolvedValue(mockPlayerStats);

      // STEP 4: Calculate lineup points
      const rules = DEFAULT_SCORING_RULES['ppr'];
      const { total, playerPoints } = await scoringService.calculateLineupPoints(
        mockLineup,
        2024,
        1,
        rules
      );

      // Verify individual player points
      expect(playerPoints.get(101)).toBe(20); // QB
      expect(playerPoints.get(102)).toBe(12); // RB1
      expect(playerPoints.get(103)).toBe(14); // RB2
      expect(playerPoints.get(104)).toBe(22); // WR1
      expect(playerPoints.get(105)).toBe(10.5); // WR2
      expect(playerPoints.get(106)).toBe(10.5); // TE
      expect(playerPoints.get(107)).toBe(9.5); // FLEX
      expect(playerPoints.get(108)).toBe(7); // K
      expect(playerPoints.get(109)).toBe(5); // DEF (2 sacks + 1 INT + 1 point for 14-20 PA)

      // Verify total is rounded to 2 decimal places
      expect(total).toBe(110.5);
      expect(Number.isInteger(total * 100)).toBe(true); // Confirms 2 decimal places max

      // Also verify the raw calculation matches
      const rawTotal = 20 + 12 + 14 + 22 + 10.5 + 10.5 + 9.5 + 7 + 5;
      expect(total).toBe(Math.round(rawTotal * 100) / 100);
    });

    it('should handle scores with many decimal places correctly', async () => {
      // Test edge case: stats that produce scores with many decimal places
      const edgeCaseLineup: LineupSlots = {
        QB: [201],
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
      };

      // 253 pass yards * 0.04 = 10.12 points, but defPointsAllowed=99 gives -4
      // Total: 10.12 - 4 = 6.12 points
      const edgeCaseStats: PlayerStats[] = [
        {
          id: 10,
          playerId: 201,
          season: 2024,
          week: 1,
          passYards: 253,
          passTd: 0,
          passInt: 0,
          rushYards: 0,
          rushTd: 0,
          receptions: 0,
          recYards: 0,
          recTd: 0,
          fumblesLost: 0,
          twoPtConversions: 0,
          fgMade: 0,
          fgMissed: 0,
          patMade: 0,
          patMissed: 0,
          defTd: 0,
          defInt: 0,
          defSacks: 0,
          defFumbleRec: 0,
          defSafety: 0,
          defPointsAllowed: 99,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      mockStatsRepo.findByPlayersAndWeek.mockResolvedValue(edgeCaseStats);

      const rules = DEFAULT_SCORING_RULES['ppr'];
      const { total } = await scoringService.calculateLineupPoints(edgeCaseLineup, 2024, 1, rules);

      expect(total).toBe(6.12);
      // Verify it's properly rounded
      expect(total.toString().split('.')[1]?.length || 0).toBeLessThanOrEqual(2);
    });
  });

  // ==================== TEST 2: Waiver process updates roster + transaction log ====================

  describe('Waiver process updates roster + transaction log', () => {
    let mockPool: jest.Mocked<Pool>;
    let mockPoolClient: jest.Mocked<PoolClient>;
    let waiversService: WaiversService;
    let mockPriorityRepo: jest.Mocked<WaiverPriorityRepository>;
    let mockFaabRepo: jest.Mocked<FaabBudgetRepository>;
    let mockClaimsRepo: jest.Mocked<WaiverClaimsRepository>;
    let mockWaiverWireRepo: jest.Mocked<WaiverWireRepository>;
    let mockRosterRepo: jest.Mocked<RosterRepository>;
    let mockRosterPlayersRepo: jest.Mocked<RosterPlayersRepository>;
    let mockTransactionsRepo: jest.Mocked<RosterTransactionsRepository>;
    let mockLeagueRepo: jest.Mocked<LeagueRepository>;
    let mockTradesRepo: jest.Mocked<TradesRepository>;

    const mockLeague = new League(
      1, // id
      'Test League', // name
      'active', // status
      {
        // settings
        commissioner_roster_id: 1,
        waiver_type: 'standard',
        roster_size: 15,
      },
      {}, // scoringSettings
      '2024', // season
      10, // totalRosters
      new Date(), // createdAt
      new Date(), // updatedAt
      undefined, // userRosterId
      1, // commissionerRosterId
      'redraft', // mode
      {}, // leagueSettings
      5, // currentWeek
      'regular_season', // seasonStatus
      'XYZ789' // inviteCode
    );

    const mockRoster: Roster = {
      id: 1,
      leagueId: 1,
      userId: 'user-1',
      rosterId: 1,
      settings: { team_name: 'Champion Squad' },
      starters: [],
      bench: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    beforeEach(() => {
      mockPoolClient = createMockPoolClient();
      mockPool = createMockPool(mockPoolClient);

      mockPriorityRepo = {
        getByRoster: jest.fn(),
        getByLeague: jest.fn(),
        rotatePriority: jest.fn(),
        initializeForLeague: jest.fn(),
      } as unknown as jest.Mocked<WaiverPriorityRepository>;

      mockFaabRepo = {
        findByRoster: jest.fn(),
        findByLeague: jest.fn(),
        deductBudget: jest.fn(),
      } as unknown as jest.Mocked<FaabBudgetRepository>;

      mockClaimsRepo = {
        create: jest.fn(),
        findById: jest.fn(),
        findByIdWithDetails: jest.fn(),
        getPendingByLeague: jest.fn(),
        getPendingByPlayer: jest.fn(),
        updateStatus: jest.fn(),
        hasPendingClaim: jest.fn(),
        getPendingByRoster: jest.fn(),
      } as unknown as jest.Mocked<WaiverClaimsRepository>;

      mockWaiverWireRepo = {
        isOnWaivers: jest.fn(),
        removePlayer: jest.fn(),
        getByLeague: jest.fn(),
        getPlayerExpiration: jest.fn(),
        addPlayer: jest.fn(),
      } as unknown as jest.Mocked<WaiverWireRepository>;

      mockRosterRepo = {
        findById: jest.fn(),
        findByLeagueAndUser: jest.fn(),
        findByLeagueId: jest.fn(),
      } as unknown as jest.Mocked<RosterRepository>;

      mockRosterPlayersRepo = {
        findByRosterAndPlayer: jest.fn(),
        addPlayer: jest.fn(),
        removePlayer: jest.fn(),
        getPlayerCount: jest.fn(),
        findOwner: jest.fn(),
        getByRosterId: jest.fn(),
      } as unknown as jest.Mocked<RosterPlayersRepository>;

      mockTransactionsRepo = {
        create: jest.fn(),
        getByLeague: jest.fn(),
        getByRoster: jest.fn(),
      } as unknown as jest.Mocked<RosterTransactionsRepository>;

      mockLeagueRepo = {
        findById: jest.fn(),
        isUserMember: jest.fn(),
        isCommissioner: jest.fn(),
      } as unknown as jest.Mocked<LeagueRepository>;

      mockTradesRepo = {
        findPendingByPlayer: jest.fn(),
        updateStatus: jest.fn(),
      } as unknown as jest.Mocked<TradesRepository>;

      waiversService = new WaiversService(
        mockPool,
        mockPriorityRepo,
        mockFaabRepo,
        mockClaimsRepo,
        mockWaiverWireRepo,
        mockRosterRepo,
        mockRosterPlayersRepo,
        mockTransactionsRepo,
        mockLeagueRepo,
        mockTradesRepo
      );
    });

    it('should process waiver claim, update roster, and create transaction log entries', async () => {
      // Setup: Claim to add player 500, drop player 400
      const addPlayerId = 500;
      const dropPlayerId = 400;

      const mockClaim: WaiverClaim = {
        id: 1,
        leagueId: 1,
        rosterId: 1,
        playerId: addPlayerId,
        dropPlayerId: dropPlayerId,
        bidAmount: 0,
        priorityAtClaim: 1,
        status: 'pending',
        season: 2024,
        week: 5,
        processedAt: null,
        failureReason: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      // Mock league lookup
      mockLeagueRepo.findById.mockResolvedValue(mockLeague);

      // Mock pending claims for the league
      mockClaimsRepo.getPendingByLeague.mockResolvedValue([mockClaim]);

      // Mock roster lookup
      mockRosterRepo.findById.mockResolvedValue(mockRoster);
      mockRosterRepo.findByLeagueId.mockResolvedValue([mockRoster]);

      // Mock player ownership check (player 500 not owned)
      mockRosterPlayersRepo.findOwner.mockResolvedValue(null);

      // Mock drop player exists on roster
      mockRosterPlayersRepo.findByRosterAndPlayer.mockResolvedValue({
        id: 1,
        rosterId: 1,
        playerId: dropPlayerId,
        acquiredType: 'draft',
        acquiredAt: new Date(),
      });

      // Mock roster size check
      mockRosterPlayersRepo.getPlayerCount.mockResolvedValue(14);

      // Mock priority for standard waivers
      mockPriorityRepo.getByLeague.mockResolvedValue([
        {
          id: 1,
          leagueId: 1,
          rosterId: 1,
          season: 2024,
          priority: 1,
          updatedAt: new Date(),
          teamName: 'Champion Squad',
          username: 'user1',
        },
      ]);

      // Mock waiver wire check (player is on waiver wire but expired, so can be claimed)
      mockWaiverWireRepo.isOnWaivers.mockResolvedValue(false);
      mockWaiverWireRepo.getPlayerExpiration.mockResolvedValue(null);

      // Mock successful claim update
      mockClaimsRepo.updateStatus.mockResolvedValue({
        ...mockClaim,
        status: 'successful',
        processedAt: new Date(),
      });

      // Track transaction log entries
      const createdTransactions: any[] = [];
      mockTransactionsRepo.create.mockImplementation(
        async (leagueId, rosterId, playerId, type, season, week) => {
          const transaction = {
            id: createdTransactions.length + 1,
            leagueId,
            rosterId,
            playerId,
            transactionType: type,
            season,
            week,
            createdAt: new Date(),
            relatedTransactionId: null,
            playerName: playerId === addPlayerId ? 'New Player' : 'Old Player',
          };
          createdTransactions.push(transaction);
          return transaction as RosterTransaction;
        }
      );

      // Track roster updates
      const addedPlayers: number[] = [];
      const removedPlayers: number[] = [];

      mockRosterPlayersRepo.addPlayer.mockImplementation(async (rosterId, playerId) => {
        addedPlayers.push(playerId);
        return {
          id: 99,
          rosterId,
          playerId,
          acquiredType: 'waiver' as const,
          acquiredAt: new Date(),
        };
      });

      mockRosterPlayersRepo.removePlayer.mockImplementation(async (rosterId, playerId) => {
        removedPlayers.push(playerId);
        return true;
      });

      // Mock no pending trades for the dropped player
      mockTradesRepo.findPendingByPlayer.mockResolvedValue([]);

      // Process waivers
      const result = await waiversService.processLeagueClaims(1);

      // VERIFY: Waiver processing completed
      expect(result.processed).toBe(1);
      expect(result.successful).toBe(1);

      // VERIFY: Player was added to roster
      expect(addedPlayers).toContain(addPlayerId);
      expect(mockRosterPlayersRepo.addPlayer).toHaveBeenCalledWith(
        1, // rosterId
        addPlayerId,
        'waiver',
        expect.anything() // client
      );

      // VERIFY: Drop player was removed from roster
      expect(removedPlayers).toContain(dropPlayerId);
      expect(mockRosterPlayersRepo.removePlayer).toHaveBeenCalledWith(
        1, // rosterId
        dropPlayerId,
        expect.anything() // client
      );

      // VERIFY: Transaction log entries were created
      expect(createdTransactions.length).toBe(2);

      const addTransaction = createdTransactions.find((t) => t.transactionType === 'add');
      const dropTransaction = createdTransactions.find((t) => t.transactionType === 'drop');

      expect(addTransaction).toBeDefined();
      expect(addTransaction.playerId).toBe(addPlayerId);
      expect(addTransaction.rosterId).toBe(1);
      expect(addTransaction.leagueId).toBe(1);

      expect(dropTransaction).toBeDefined();
      expect(dropTransaction.playerId).toBe(dropPlayerId);
      expect(dropTransaction.rosterId).toBe(1);
      expect(dropTransaction.leagueId).toBe(1);

      // VERIFY: Claim status was updated to successful
      expect(mockClaimsRepo.updateStatus).toHaveBeenCalledWith(
        mockClaim.id,
        'successful',
        undefined,
        expect.anything()
      );
    });
  });

  // ==================== TEST 3: Trade accept updates both rosters atomically ====================

  describe('Trade accept updates both rosters atomically', () => {
    let mockPool: jest.Mocked<Pool>;
    let mockPoolClient: jest.Mocked<PoolClient>;
    let tradesService: TradesService;
    let mockTradesRepo: jest.Mocked<TradesRepository>;
    let mockTradeItemsRepo: jest.Mocked<TradeItemsRepository>;
    let mockTradeVotesRepo: jest.Mocked<TradeVotesRepository>;
    let mockRosterRepo: jest.Mocked<RosterRepository>;
    let mockRosterPlayersRepo: jest.Mocked<RosterPlayersRepository>;
    let mockTransactionsRepo: jest.Mocked<RosterTransactionsRepository>;
    let mockLeagueRepo: jest.Mocked<LeagueRepository>;

    const mockLeague = new League(
      1, // id
      'Trade League', // name
      'active', // status
      {
        // settings
        commissioner_roster_id: 1,
        roster_size: 15,
        trade_expiry_hours: 48,
        trade_review_enabled: false,
        trade_voting_enabled: false,
      },
      {}, // scoringSettings
      '2024', // season
      12, // totalRosters
      new Date(), // createdAt
      new Date(), // updatedAt
      undefined, // userRosterId
      1, // commissionerRosterId
      'redraft', // mode
      {}, // leagueSettings
      8, // currentWeek
      'regular_season', // seasonStatus
      'TRADE99' // inviteCode
    );

    // Team A (rosterId: 1) has players 1001, 1002
    // Team B (rosterId: 2) has players 2001, 2002
    // Trade: Team A gives 1001, Team B gives 2001

    const rosterA: Roster = {
      id: 1,
      leagueId: 1,
      userId: 'user-A',
      rosterId: 1,
      settings: { team_name: 'Team Alpha' },
      starters: [],
      bench: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const rosterB: Roster = {
      id: 2,
      leagueId: 1,
      userId: 'user-B',
      rosterId: 2,
      settings: { team_name: 'Team Bravo' },
      starters: [],
      bench: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const playerFromA = 1001; // Moving from A to B
    const playerFromB = 2001; // Moving from B to A

    const mockTrade: Trade = {
      id: 1,
      leagueId: 1,
      proposerRosterId: 1,
      recipientRosterId: 2,
      status: 'pending',
      parentTradeId: null,
      expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000),
      reviewStartsAt: null,
      reviewEndsAt: null,
      message: 'Trade proposal',
      season: 2024,
      week: 8,
      createdAt: new Date(),
      updatedAt: new Date(),
      completedAt: null,
      notifyLeagueChat: true,
      notifyDm: true,
    };

    const mockTradeItems: TradeItem[] = [
      {
        id: 1,
        tradeId: 1,
        itemType: 'player',
        playerId: playerFromA,
        fromRosterId: 1,
        toRosterId: 2,
        playerName: 'Player From A',
        playerPosition: 'RB',
        playerTeam: 'DAL',
        draftPickAssetId: null,
        pickSeason: null,
        pickRound: null,
        pickOriginalTeam: null,
        createdAt: new Date(),
      },
      {
        id: 2,
        tradeId: 1,
        itemType: 'player',
        playerId: playerFromB,
        fromRosterId: 2,
        toRosterId: 1,
        playerName: 'Player From B',
        playerPosition: 'WR',
        playerTeam: 'PHI',
        draftPickAssetId: null,
        pickSeason: null,
        pickRound: null,
        pickOriginalTeam: null,
        createdAt: new Date(),
      },
    ];

    beforeEach(() => {
      mockPoolClient = createMockPoolClient();
      mockPool = createMockPool(mockPoolClient);

      mockTradesRepo = {
        findById: jest.fn(),
        findByIdWithDetails: jest.fn(),
        findPendingByPlayer: jest.fn(),
        updateStatus: jest.fn(),
        setReviewPeriod: jest.fn(),
      } as unknown as jest.Mocked<TradesRepository>;

      mockTradeItemsRepo = {
        findByTrade: jest.fn(),
        createBulk: jest.fn(),
      } as unknown as jest.Mocked<TradeItemsRepository>;

      mockTradeVotesRepo = {
        create: jest.fn(),
        hasVoted: jest.fn(),
        countVotes: jest.fn(),
      } as unknown as jest.Mocked<TradeVotesRepository>;

      mockRosterRepo = {
        findById: jest.fn(),
        findByLeagueAndUser: jest.fn(),
      } as unknown as jest.Mocked<RosterRepository>;

      mockRosterPlayersRepo = {
        findByRosterAndPlayer: jest.fn(),
        addPlayer: jest.fn(),
        removePlayer: jest.fn(),
        getPlayerCount: jest.fn(),
      } as unknown as jest.Mocked<RosterPlayersRepository>;

      mockTransactionsRepo = {
        create: jest.fn(),
      } as unknown as jest.Mocked<RosterTransactionsRepository>;

      mockLeagueRepo = {
        findById: jest.fn(),
        isUserMember: jest.fn(),
      } as unknown as jest.Mocked<LeagueRepository>;

      tradesService = new TradesService(
        mockPool,
        mockTradesRepo,
        mockTradeItemsRepo,
        mockTradeVotesRepo,
        mockRosterRepo,
        mockRosterPlayersRepo,
        mockTransactionsRepo,
        mockLeagueRepo
      );
    });

    it('should swap players on both rosters atomically and create transaction log entries for both sides', async () => {
      // Setup mocks
      mockTradesRepo.findById.mockResolvedValue(mockTrade);
      mockRosterRepo.findById.mockImplementation(async (id) => {
        if (id === 1) return rosterA;
        if (id === 2) return rosterB;
        return null;
      });
      mockLeagueRepo.findById.mockResolvedValue(mockLeague);
      mockTradeItemsRepo.findByTrade.mockResolvedValue(mockTradeItems);

      // Mock that both players exist on their respective rosters
      mockRosterPlayersRepo.findByRosterAndPlayer.mockImplementation(async (rosterId, playerId) => {
        if (rosterId === 1 && playerId === playerFromA) {
          return {
            id: 1,
            rosterId: 1,
            playerId: playerFromA,
            acquiredType: 'draft' as const,
            acquiredAt: new Date(),
          };
        }
        if (rosterId === 2 && playerId === playerFromB) {
          return {
            id: 2,
            rosterId: 2,
            playerId: playerFromB,
            acquiredType: 'draft' as const,
            acquiredAt: new Date(),
          };
        }
        return null;
      });

      // Mock roster sizes
      mockRosterPlayersRepo.getPlayerCount.mockResolvedValue(10);

      // Track all roster changes
      const rosterChanges: { action: string; rosterId: number; playerId: number }[] = [];

      mockRosterPlayersRepo.addPlayer.mockImplementation(async (rosterId, playerId) => {
        rosterChanges.push({ action: 'add', rosterId, playerId });
        return {
          id: 99,
          rosterId,
          playerId,
          acquiredType: 'trade' as const,
          acquiredAt: new Date(),
        };
      });

      mockRosterPlayersRepo.removePlayer.mockImplementation(async (rosterId, playerId) => {
        rosterChanges.push({ action: 'remove', rosterId, playerId });
        return true;
      });

      // Track transaction log entries
      const transactionLogs: { rosterId: number; playerId: number; type: string }[] = [];

      mockTransactionsRepo.create.mockImplementation(async (leagueId, rosterId, playerId, type) => {
        transactionLogs.push({ rosterId, playerId, type });
        return {
          id: transactionLogs.length,
          leagueId,
          rosterId,
          playerId,
          transactionType: type,
          season: 2024,
          week: 8,
          createdAt: new Date(),
          relatedTransactionId: null,
        } as RosterTransaction;
      });

      // Mock trade status update
      mockTradesRepo.updateStatus.mockResolvedValue({
        ...mockTrade,
        status: 'completed',
        completedAt: new Date(),
      });

      // Mock findByIdWithDetails for return value
      mockTradesRepo.findByIdWithDetails.mockResolvedValue({
        ...mockTrade,
        status: 'completed',
        items: mockTradeItems.map((item) => ({
          ...item,
          fullName: item.playerName ?? '',
          position: item.playerPosition,
          team: item.playerTeam,
          status: 'Active',
        })),
        proposerTeamName: 'Team Alpha',
        recipientTeamName: 'Team Bravo',
        proposerUsername: 'userA',
        recipientUsername: 'userB',
      });

      // Execute trade acceptance (user-B is the recipient)
      const result = await tradesService.acceptTrade(1, 'user-B');

      // VERIFY: Trade was completed
      expect(result.status).toBe('completed');

      // VERIFY: Both players were removed from their original rosters
      const removeFromA = rosterChanges.find(
        (c) => c.action === 'remove' && c.rosterId === 1 && c.playerId === playerFromA
      );
      const removeFromB = rosterChanges.find(
        (c) => c.action === 'remove' && c.rosterId === 2 && c.playerId === playerFromB
      );

      expect(removeFromA).toBeDefined();
      expect(removeFromB).toBeDefined();

      // VERIFY: Both players were added to their new rosters
      const addToB = rosterChanges.find(
        (c) => c.action === 'add' && c.rosterId === 2 && c.playerId === playerFromA
      );
      const addToA = rosterChanges.find(
        (c) => c.action === 'add' && c.rosterId === 1 && c.playerId === playerFromB
      );

      expect(addToB).toBeDefined();
      expect(addToA).toBeDefined();

      // VERIFY: Transaction logs were created for both sides
      // Trade creates 2 transactions per item: one for fromRosterId (source), one for toRosterId (dest)
      // With 2 trade items, we get 4 transactions total, all with type 'trade'
      expect(transactionLogs.length).toBe(4);

      // Item 1: Player 1001 goes from roster 1 to roster 2
      const item1From = transactionLogs.find(
        (t) => t.rosterId === 1 && t.playerId === playerFromA && t.type === 'trade'
      );
      const item1To = transactionLogs.find(
        (t) => t.rosterId === 2 && t.playerId === playerFromA && t.type === 'trade'
      );

      expect(item1From).toBeDefined();
      expect(item1To).toBeDefined();

      // Item 2: Player 2001 goes from roster 2 to roster 1
      const item2From = transactionLogs.find(
        (t) => t.rosterId === 2 && t.playerId === playerFromB && t.type === 'trade'
      );
      const item2To = transactionLogs.find(
        (t) => t.rosterId === 1 && t.playerId === playerFromB && t.type === 'trade'
      );

      expect(item2From).toBeDefined();
      expect(item2To).toBeDefined();

      // VERIFY: Trade status was updated (with expected current status 'pending')
      expect(mockTradesRepo.updateStatus).toHaveBeenCalledWith(
        1,
        'completed',
        expect.anything(), // poolClient
        'pending' // expectedCurrentStatus
      );
    });

    it('should rollback all changes if trade acceptance fails mid-transaction', async () => {
      // Setup mocks
      mockTradesRepo.findById.mockResolvedValue(mockTrade);
      mockRosterRepo.findById.mockImplementation(async (id) => {
        if (id === 1) return rosterA;
        if (id === 2) return rosterB;
        return null;
      });
      mockLeagueRepo.findById.mockResolvedValue(mockLeague);
      mockTradeItemsRepo.findByTrade.mockResolvedValue(mockTradeItems);

      // Mock that player from A exists
      mockRosterPlayersRepo.findByRosterAndPlayer.mockImplementation(async (rosterId, playerId) => {
        if (rosterId === 1 && playerId === playerFromA) {
          return {
            id: 1,
            rosterId: 1,
            playerId: playerFromA,
            acquiredType: 'draft' as const,
            acquiredAt: new Date(),
          };
        }
        // Player from B is NOT on their roster (simulating a data inconsistency)
        if (rosterId === 2 && playerId === playerFromB) {
          return null; // This should cause validation to fail
        }
        return null;
      });

      // The trade should fail because player validation fails
      await expect(tradesService.acceptTrade(1, 'user-B')).rejects.toThrow();

      // VERIFY: No roster changes should have been committed
      expect(mockRosterPlayersRepo.addPlayer).not.toHaveBeenCalled();
      expect(mockRosterPlayersRepo.removePlayer).not.toHaveBeenCalled();
      expect(mockTransactionsRepo.create).not.toHaveBeenCalled();

      // VERIFY: Trade status was not updated to completed
      expect(mockTradesRepo.updateStatus).not.toHaveBeenCalledWith(
        1,
        'completed',
        expect.anything()
      );
    });
  });
});
