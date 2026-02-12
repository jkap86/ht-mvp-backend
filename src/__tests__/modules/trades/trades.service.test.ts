import { Pool, PoolClient } from 'pg';
import { TradesService } from '../../../modules/trades/trades.service';
import {
  TradesRepository,
  TradeItemsRepository,
  TradeVotesRepository,
} from '../../../modules/trades/trades.repository';
import {
  RosterPlayersRepository,
  RosterTransactionsRepository,
} from '../../../modules/rosters/rosters.repository';
import { RosterMutationService } from '../../../modules/rosters/roster-mutation.service';
import { LeagueRepository, RosterRepository } from '../../../modules/leagues/leagues.repository';
import { PlayerRepository } from '../../../modules/players/players.repository';
import {
  Trade,
  TradeItem,
  TradeWithDetails,
  TradeItemWithPlayer,
} from '../../../modules/trades/trades.model';
import {
  NotFoundException,
  ForbiddenException,
  ValidationException,
  ConflictException,
} from '../../../utils/exceptions';

// Mock socket service
jest.mock('../../../socket', () => ({
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
  })),
}));

// Mock data
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
  message: 'Test trade',
  season: 2024,
  week: 1,
  createdAt: new Date(),
  updatedAt: new Date(),
  completedAt: null,
  failureReason: null,
  notifyLeagueChat: true,
  notifyDm: true,
  leagueChatMode: 'summary',
};

const mockTradeItem: TradeItem = {
  id: 1,
  tradeId: 1,
  itemType: 'player',
  playerId: 100,
  fromRosterId: 1,
  toRosterId: 2,
  playerName: 'Test Player',
  playerPosition: 'QB',
  playerTeam: 'TST',
  draftPickAssetId: null,
  pickSeason: null,
  pickRound: null,
  pickOriginalTeam: null,
  createdAt: new Date(),
};

const mockTradeItemWithPlayer: TradeItemWithPlayer = {
  ...mockTradeItem,
  fullName: 'Test Player',
  position: 'QB',
  team: 'TST',
  status: 'Active',
};

const mockTradeWithDetails: TradeWithDetails = {
  ...mockTrade,
  items: [mockTradeItemWithPlayer],
  proposerTeamName: 'Team 1',
  recipientTeamName: 'Team 2',
  proposerUsername: 'user1',
  recipientUsername: 'user2',
};

const mockRoster: any = {
  id: 1,
  leagueId: 1,
  userId: 'user-123',
  settings: {},
  createdAt: new Date(),
  updatedAt: new Date(),
};

const mockRoster2: any = {
  id: 2,
  leagueId: 1,
  userId: 'user-456',
  settings: {},
  createdAt: new Date(),
  updatedAt: new Date(),
};

const mockLeague: any = {
  id: 1,
  name: 'Test League',
  season: '2024',
  currentWeek: 1,
  settings: {
    roster_size: 15,
    trade_expiry_hours: 48,
    trade_review_enabled: false,
    trade_voting_enabled: false,
    trade_veto_count: 4,
  },
};

const mockRosterPlayer: any = {
  id: 1,
  rosterId: 1,
  playerId: 100,
  acquiredVia: 'draft',
  addedAt: new Date(),
};

// Mock pool client with batch query support
const createMockPoolClient = (): jest.Mocked<PoolClient> => {
  const mockQuery = jest.fn().mockImplementation((query: string, params?: unknown[]) => {
    // Default: return empty rows
    return Promise.resolve({ rows: [] });
  });

  return {
    query: mockQuery,
    release: jest.fn(),
  } as unknown as jest.Mocked<PoolClient>;
};

/**
 * Configure the mock pool client to handle batch roster player validation queries.
 * This simulates the batchValidateRosterPlayers function returning that players are owned.
 */
function setupBatchValidationMock(
  mockClient: jest.Mocked<PoolClient>,
  ownedPlayers: { rosterId: number; playerIds: number[] }[]
): void {
  (mockClient.query as jest.Mock).mockImplementation((query: string, params?: unknown[]) => {
    // Handle batch roster player validation query
    if (
      typeof query === 'string' &&
      query.includes('SELECT player_id FROM roster_players') &&
      query.includes('AND player_id = ANY')
    ) {
      const rosterId = params?.[0] as number;
      const playerIds = params?.[1] as number[];

      // Find which players this roster owns
      const ownedConfig = ownedPlayers.find((o) => o.rosterId === rosterId);
      if (ownedConfig) {
        const foundPlayers = playerIds.filter((id) => ownedConfig.playerIds.includes(id));
        return Promise.resolve({
          rows: foundPlayers.map((id) => ({ player_id: id })),
        });
      }
      return Promise.resolve({ rows: [] });
    }

    // Handle player details query
    if (typeof query === 'string' && query.includes('SELECT full_name')) {
      return Promise.resolve({
        rows: [{ full_name: 'Test Player', position: 'QB', team: 'TST' }],
      });
    }

    // Default: return empty rows
    return Promise.resolve({ rows: [] });
  });
}

// Mock pool
const createMockPool = (mockClient: jest.Mocked<PoolClient>): jest.Mocked<Pool> =>
  ({
    connect: jest.fn().mockResolvedValue(mockClient),
  }) as unknown as jest.Mocked<Pool>;

// Mock repositories
const createMockTradesRepo = (): jest.Mocked<TradesRepository> =>
  ({
    findById: jest.fn(),
    findByLeague: jest.fn(),
    findByLeagueWithDetails: jest.fn(),
    findByIdWithDetails: jest.fn(),
    findPendingByPlayer: jest.fn(),
    findExpiredTrades: jest.fn(),
    findReviewCompleteTrades: jest.fn(),
    create: jest.fn(),
    updateStatus: jest.fn(),
    setReviewPeriod: jest.fn(),
  }) as unknown as jest.Mocked<TradesRepository>;

const createMockTradeItemsRepo = (): jest.Mocked<TradeItemsRepository> =>
  ({
    createBulk: jest.fn(),
    findByTrade: jest.fn(),
  }) as unknown as jest.Mocked<TradeItemsRepository>;

const createMockTradeVotesRepo = (): jest.Mocked<TradeVotesRepository> =>
  ({
    create: jest.fn(),
    hasVoted: jest.fn(),
    countVotes: jest.fn(),
  }) as unknown as jest.Mocked<TradeVotesRepository>;

const createMockRosterRepo = (): jest.Mocked<RosterRepository> =>
  ({
    findById: jest.fn(),
    findByLeagueAndUser: jest.fn(),
    findByLeagueAndRosterId: jest.fn(),
  }) as unknown as jest.Mocked<RosterRepository>;

const createMockRosterPlayersRepo = (): jest.Mocked<RosterPlayersRepository> =>
  ({
    findByRosterAndPlayer: jest.fn(),
    getPlayerCount: jest.fn(),
    addPlayer: jest.fn(),
    removePlayer: jest.fn(),
  }) as unknown as jest.Mocked<RosterPlayersRepository>;

const createMockTransactionsRepo = (): jest.Mocked<RosterTransactionsRepository> =>
  ({
    create: jest.fn(),
  }) as unknown as jest.Mocked<RosterTransactionsRepository>;

const createMockLeagueRepo = (): jest.Mocked<LeagueRepository> =>
  ({
    findById: jest.fn(),
    isUserMember: jest.fn(),
  }) as unknown as jest.Mocked<LeagueRepository>;

const createMockRosterMutationService = (): jest.Mocked<RosterMutationService> =>
  ({
    addPlayerToRoster: jest.fn(),
    removePlayerFromRoster: jest.fn(),
    swapPlayers: jest.fn(),
    bulkRemovePlayers: jest.fn(),
    bulkAddPlayers: jest.fn(),
  }) as unknown as jest.Mocked<RosterMutationService>;

const createMockPlayerRepo = (): jest.Mocked<PlayerRepository> =>
  ({
    findById: jest.fn(),
    findByIds: jest.fn(),
    findByIdsWithDetails: jest.fn(),
  }) as unknown as jest.Mocked<PlayerRepository>;

describe('TradesService', () => {
  let tradesService: TradesService;
  let mockPool: jest.Mocked<Pool>;
  let mockPoolClient: jest.Mocked<PoolClient>;
  let mockTradesRepo: jest.Mocked<TradesRepository>;
  let mockTradeItemsRepo: jest.Mocked<TradeItemsRepository>;
  let mockTradeVotesRepo: jest.Mocked<TradeVotesRepository>;
  let mockRosterRepo: jest.Mocked<RosterRepository>;
  let mockRosterPlayersRepo: jest.Mocked<RosterPlayersRepository>;
  let mockTransactionsRepo: jest.Mocked<RosterTransactionsRepository>;
  let mockLeagueRepo: jest.Mocked<LeagueRepository>;
  let mockPlayerRepo: jest.Mocked<PlayerRepository>;
  let mockRosterMutationService: jest.Mocked<RosterMutationService>;

  beforeEach(() => {
    mockPoolClient = createMockPoolClient();
    mockPool = createMockPool(mockPoolClient);
    mockTradesRepo = createMockTradesRepo();
    mockTradeItemsRepo = createMockTradeItemsRepo();
    mockTradeVotesRepo = createMockTradeVotesRepo();
    mockRosterRepo = createMockRosterRepo();
    mockRosterPlayersRepo = createMockRosterPlayersRepo();
    mockTransactionsRepo = createMockTransactionsRepo();
    mockLeagueRepo = createMockLeagueRepo();
    mockPlayerRepo = createMockPlayerRepo();
    mockRosterMutationService = createMockRosterMutationService();

    tradesService = new TradesService(
      mockPool,
      mockTradesRepo,
      mockTradeItemsRepo,
      mockTradeVotesRepo,
      mockRosterRepo,
      mockRosterPlayersRepo,
      mockTransactionsRepo,
      mockLeagueRepo,
      mockPlayerRepo,
      mockRosterMutationService,
      undefined // eventListenerService
    );
  });

  describe('proposeTrade', () => {
    const proposeRequest = {
      recipientRosterId: 2,
      offeringPlayerIds: [100],
      requestingPlayerIds: [200],
      message: 'Trade offer',
    };

    it('should throw ForbiddenException when user not in league', async () => {
      mockRosterRepo.findByLeagueAndUser.mockResolvedValue(null);

      await expect(tradesService.proposeTrade(1, 'user-123', proposeRequest)).rejects.toThrow(
        ForbiddenException
      );
      await expect(tradesService.proposeTrade(1, 'user-123', proposeRequest)).rejects.toThrow(
        'not a member of this league'
      );
    });

    it('should throw NotFoundException when recipient roster not found', async () => {
      mockRosterRepo.findByLeagueAndUser.mockResolvedValue(mockRoster);
      mockRosterRepo.findByLeagueAndRosterId.mockResolvedValue(null);

      await expect(tradesService.proposeTrade(1, 'user-123', proposeRequest)).rejects.toThrow(
        NotFoundException
      );
      await expect(tradesService.proposeTrade(1, 'user-123', proposeRequest)).rejects.toThrow(
        'Recipient roster not found'
      );
    });

    it('should throw ValidationException when trading with self', async () => {
      mockRosterRepo.findByLeagueAndUser.mockResolvedValue(mockRoster);
      mockRosterRepo.findByLeagueAndRosterId.mockResolvedValue(mockRoster); // Same roster

      await expect(
        tradesService.proposeTrade(1, 'user-123', { ...proposeRequest, recipientRosterId: 1 })
      ).rejects.toThrow(ValidationException);
      await expect(
        tradesService.proposeTrade(1, 'user-123', { ...proposeRequest, recipientRosterId: 1 })
      ).rejects.toThrow('Cannot trade with yourself');
    });

    it('should throw ValidationException when trade deadline passed', async () => {
      mockRosterRepo.findByLeagueAndUser.mockResolvedValue(mockRoster);
      mockRosterRepo.findByLeagueAndRosterId.mockResolvedValue(mockRoster2);
      mockLeagueRepo.findById.mockResolvedValue({
        ...mockLeague,
        settings: { ...mockLeague.settings, trade_deadline: '2020-01-01' },
      });

      await expect(tradesService.proposeTrade(1, 'user-123', proposeRequest)).rejects.toThrow(
        ValidationException
      );
      await expect(tradesService.proposeTrade(1, 'user-123', proposeRequest)).rejects.toThrow(
        'Trade deadline has passed'
      );
    });

    it('should throw ValidationException when no players included', async () => {
      mockRosterRepo.findByLeagueAndUser.mockResolvedValue(mockRoster);
      mockRosterRepo.findByLeagueAndRosterId.mockResolvedValue(mockRoster2);
      mockLeagueRepo.findById.mockResolvedValue(mockLeague);

      await expect(
        tradesService.proposeTrade(1, 'user-123', {
          recipientRosterId: 2,
          offeringPlayerIds: [],
          requestingPlayerIds: [],
        })
      ).rejects.toThrow(ValidationException);
      await expect(
        tradesService.proposeTrade(1, 'user-123', {
          recipientRosterId: 2,
          offeringPlayerIds: [],
          requestingPlayerIds: [],
        })
      ).rejects.toThrow('must include at least one player');
    });

    it('should throw ValidationException when proposer does not own offered player', async () => {
      mockRosterRepo.findByLeagueAndUser.mockResolvedValue(mockRoster);
      mockRosterRepo.findByLeagueAndRosterId.mockResolvedValue(mockRoster2);
      mockLeagueRepo.findById.mockResolvedValue(mockLeague);
      mockRosterPlayersRepo.findByRosterAndPlayer.mockResolvedValue(null);

      await expect(tradesService.proposeTrade(1, 'user-123', proposeRequest)).rejects.toThrow(
        ValidationException
      );
      await expect(tradesService.proposeTrade(1, 'user-123', proposeRequest)).rejects.toThrow(
        'You do not own player'
      );
    });

    it('should throw ConflictException when player already in pending trade', async () => {
      mockRosterRepo.findByLeagueAndUser.mockResolvedValue(mockRoster);
      mockRosterRepo.findByLeagueAndRosterId.mockResolvedValue(mockRoster2);
      mockLeagueRepo.findById.mockResolvedValue(mockLeague);
      // Setup batch validation to return that proposer owns player 100 and recipient owns player 200
      setupBatchValidationMock(mockPoolClient, [
        { rosterId: 1, playerIds: [100] },
        { rosterId: 2, playerIds: [200] },
      ]);
      // findPendingPlayerIds returns a Set of player IDs that are in pending trades
      mockTradesRepo.findPendingPlayerIds = jest.fn().mockResolvedValue(new Set([100]));

      await expect(tradesService.proposeTrade(1, 'user-123', proposeRequest)).rejects.toThrow(
        ConflictException
      );
      await expect(tradesService.proposeTrade(1, 'user-123', proposeRequest)).rejects.toThrow(
        'already in a pending trade'
      );
    });

    it('should create trade successfully', async () => {
      mockRosterRepo.findByLeagueAndUser.mockResolvedValue(mockRoster);
      mockRosterRepo.findByLeagueAndRosterId.mockResolvedValue(mockRoster2);
      mockLeagueRepo.findById.mockResolvedValue(mockLeague);
      // Setup batch validation to return that proposer owns player 100 and recipient owns player 200
      setupBatchValidationMock(mockPoolClient, [
        { rosterId: 1, playerIds: [100] },
        { rosterId: 2, playerIds: [200] },
      ]);
      // No players in pending trades
      mockTradesRepo.findPendingPlayerIds = jest.fn().mockResolvedValue(new Set());
      mockRosterPlayersRepo.getPlayerCount.mockResolvedValue(10);
      mockTradesRepo.create.mockResolvedValue(mockTrade);
      mockTradesRepo.findByIdWithDetails.mockResolvedValue(mockTradeWithDetails);
      // Mock player repository to return player details
      mockPlayerRepo.findByIdsWithDetails.mockResolvedValue(
        new Map([
          [100, { fullName: 'Offered Player', position: 'QB', team: 'TST' }],
          [200, { fullName: 'Requested Player', position: 'RB', team: 'OPP' }],
        ])
      );

      const result = await tradesService.proposeTrade(1, 'user-123', proposeRequest);

      expect(result).toBeDefined();
      expect(mockTradesRepo.create).toHaveBeenCalled();
      expect(mockTradeItemsRepo.createBulk).toHaveBeenCalled();
    });
  });

  describe('acceptTrade', () => {
    it('should throw NotFoundException when trade not found', async () => {
      mockTradesRepo.findById.mockResolvedValue(null);

      await expect(tradesService.acceptTrade(1, 'user-456')).rejects.toThrow(NotFoundException);
      await expect(tradesService.acceptTrade(1, 'user-456')).rejects.toThrow('Trade not found');
    });

    it('should throw ForbiddenException when user is not recipient', async () => {
      mockTradesRepo.findById.mockResolvedValue(mockTrade);
      mockRosterRepo.findById.mockResolvedValue(mockRoster); // Wrong user

      await expect(tradesService.acceptTrade(1, 'wrong-user')).rejects.toThrow(ForbiddenException);
      await expect(tradesService.acceptTrade(1, 'wrong-user')).rejects.toThrow(
        'Only the recipient can accept'
      );
    });

    it('should throw ValidationException when trade not pending', async () => {
      const completedTrade = { ...mockTrade, status: 'completed' as const };
      mockTradesRepo.findById.mockResolvedValue(completedTrade);
      mockRosterRepo.findById.mockResolvedValue(mockRoster2);

      await expect(tradesService.acceptTrade(1, 'user-456')).rejects.toThrow(ValidationException);
      await expect(tradesService.acceptTrade(1, 'user-456')).rejects.toThrow('Cannot accept trade');
    });

    it('should execute trade immediately when no review period', async () => {
      mockTradesRepo.findById.mockResolvedValue(mockTrade);
      mockRosterRepo.findById.mockResolvedValue(mockRoster2);
      mockLeagueRepo.findById.mockResolvedValue(mockLeague);
      mockTradeItemsRepo.findByTrade.mockResolvedValue([mockTradeItem]);
      // Setup batch validation mock - player 100 owned by roster 1
      setupBatchValidationMock(mockPoolClient, [{ rosterId: 1, playerIds: [100] }]);
      mockTradesRepo.updateStatus.mockResolvedValue({ ...mockTrade, status: 'completed' });
      mockTradesRepo.findByIdWithDetails.mockResolvedValue({
        ...mockTradeWithDetails,
        status: 'completed',
      });
      mockTransactionsRepo.create.mockResolvedValue({ id: 1 } as any);

      const result = await tradesService.acceptTrade(1, 'user-456');

      expect(result.status).toBe('completed');
      // Trade execution now uses RosterMutationService
      expect(mockRosterMutationService.bulkRemovePlayers).toHaveBeenCalled();
      expect(mockRosterMutationService.bulkAddPlayers).toHaveBeenCalled();
    });

    it('should set review period when enabled', async () => {
      const leagueWithReview = {
        ...mockLeague,
        settings: { ...mockLeague.settings, trade_review_enabled: true },
      };
      mockTradesRepo.findById.mockResolvedValue(mockTrade);
      mockRosterRepo.findById.mockResolvedValue(mockRoster2);
      mockLeagueRepo.findById.mockResolvedValue(leagueWithReview);
      mockTradeItemsRepo.findByTrade.mockResolvedValue([mockTradeItem]);
      // Setup batch validation mock - player 100 owned by roster 1
      setupBatchValidationMock(mockPoolClient, [{ rosterId: 1, playerIds: [100] }]);
      mockTradesRepo.setReviewPeriod.mockResolvedValue({
        ...mockTrade,
        status: 'in_review',
        reviewStartsAt: new Date(),
        reviewEndsAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      });
      mockTradesRepo.findByIdWithDetails.mockResolvedValue({
        ...mockTradeWithDetails,
        status: 'in_review',
      });

      const result = await tradesService.acceptTrade(1, 'user-456');

      expect(result.status).toBe('in_review');
      expect(mockTradesRepo.setReviewPeriod).toHaveBeenCalled();
    });
  });

  describe('rejectTrade', () => {
    it('should throw NotFoundException when trade not found', async () => {
      mockTradesRepo.findById.mockResolvedValue(null);

      await expect(tradesService.rejectTrade(1, 'user-456')).rejects.toThrow(NotFoundException);
    });

    it('should throw ForbiddenException when user is not recipient', async () => {
      mockTradesRepo.findById.mockResolvedValue(mockTrade);
      mockRosterRepo.findById.mockResolvedValue(mockRoster);

      await expect(tradesService.rejectTrade(1, 'wrong-user')).rejects.toThrow(ForbiddenException);
      await expect(tradesService.rejectTrade(1, 'wrong-user')).rejects.toThrow(
        'Only the recipient can reject'
      );
    });

    it('should reject trade successfully', async () => {
      mockTradesRepo.findById.mockResolvedValue(mockTrade);
      mockRosterRepo.findById.mockResolvedValue(mockRoster2);
      mockTradesRepo.updateStatus.mockResolvedValue({ ...mockTrade, status: 'rejected' });
      mockTradesRepo.findByIdWithDetails.mockResolvedValue({
        ...mockTradeWithDetails,
        status: 'rejected',
      });

      const result = await tradesService.rejectTrade(1, 'user-456');

      expect(result.status).toBe('rejected');
      expect(mockTradesRepo.updateStatus).toHaveBeenCalledWith(1, 'rejected', expect.anything());
    });
  });

  describe('cancelTrade', () => {
    it('should throw NotFoundException when trade not found', async () => {
      mockTradesRepo.findById.mockResolvedValue(null);

      await expect(tradesService.cancelTrade(1, 'user-123')).rejects.toThrow(NotFoundException);
    });

    it('should throw ForbiddenException when user is not proposer', async () => {
      mockTradesRepo.findById.mockResolvedValue(mockTrade);
      mockRosterRepo.findById.mockResolvedValue(mockRoster2);

      await expect(tradesService.cancelTrade(1, 'wrong-user')).rejects.toThrow(ForbiddenException);
      await expect(tradesService.cancelTrade(1, 'wrong-user')).rejects.toThrow(
        'Only the proposer can cancel'
      );
    });

    it('should cancel trade successfully', async () => {
      mockTradesRepo.findById.mockResolvedValue(mockTrade);
      mockRosterRepo.findById.mockResolvedValue(mockRoster);
      mockTradesRepo.updateStatus.mockResolvedValue({ ...mockTrade, status: 'cancelled' });
      mockTradesRepo.findByIdWithDetails.mockResolvedValue({
        ...mockTradeWithDetails,
        status: 'cancelled',
      });

      const result = await tradesService.cancelTrade(1, 'user-123');

      expect(result.status).toBe('cancelled');
      expect(mockTradesRepo.updateStatus).toHaveBeenCalledWith(1, 'cancelled', expect.anything());
    });
  });

  describe('counterTrade', () => {
    const counterRequest = {
      offeringPlayerIds: [200],
      requestingPlayerIds: [100],
      message: 'Counter offer',
    };

    it('should throw NotFoundException when trade not found', async () => {
      mockTradesRepo.findById.mockResolvedValue(null);

      await expect(tradesService.counterTrade(1, 'user-456', counterRequest)).rejects.toThrow(
        NotFoundException
      );
    });

    it('should throw ForbiddenException when user is not recipient', async () => {
      mockTradesRepo.findById.mockResolvedValue(mockTrade);
      mockRosterRepo.findById.mockResolvedValue(mockRoster);

      await expect(tradesService.counterTrade(1, 'wrong-user', counterRequest)).rejects.toThrow(
        ForbiddenException
      );
    });

    it('should throw ValidationException when trade not pending', async () => {
      const completedTrade = { ...mockTrade, status: 'completed' as const };
      mockTradesRepo.findById.mockResolvedValue(completedTrade);
      mockRosterRepo.findById.mockResolvedValue(mockRoster2);

      await expect(tradesService.counterTrade(1, 'user-456', counterRequest)).rejects.toThrow(
        ValidationException
      );
    });
  });

  describe('voteTrade', () => {
    const inReviewTrade = { ...mockTrade, status: 'in_review' as const };
    const thirdRoster: any = {
      id: 3,
      leagueId: 1,
      userId: 'user-789',
      settings: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    it('should throw NotFoundException when trade not found', async () => {
      mockTradesRepo.findById.mockResolvedValue(null);

      await expect(tradesService.voteTrade(1, 'user-789', 'approve')).rejects.toThrow(
        NotFoundException
      );
    });

    it('should throw ValidationException when trade not in review', async () => {
      mockTradesRepo.findById.mockResolvedValue(mockTrade); // pending, not in_review

      await expect(tradesService.voteTrade(1, 'user-789', 'approve')).rejects.toThrow(
        ValidationException
      );
      await expect(tradesService.voteTrade(1, 'user-789', 'approve')).rejects.toThrow(
        'not in review period'
      );
    });

    it('should throw ForbiddenException when user not in league', async () => {
      mockTradesRepo.findById.mockResolvedValue(inReviewTrade);
      mockRosterRepo.findByLeagueAndUser.mockResolvedValue(null);

      await expect(tradesService.voteTrade(1, 'user-789', 'approve')).rejects.toThrow(
        ForbiddenException
      );
    });

    it('should throw ForbiddenException when voting on own trade', async () => {
      mockTradesRepo.findById.mockResolvedValue(inReviewTrade);
      mockRosterRepo.findByLeagueAndUser.mockResolvedValue(mockRoster); // proposer

      await expect(tradesService.voteTrade(1, 'user-123', 'approve')).rejects.toThrow(
        ForbiddenException
      );
      await expect(tradesService.voteTrade(1, 'user-123', 'approve')).rejects.toThrow(
        'Cannot vote on your own trade'
      );
    });

    it('should throw ConflictException when already voted', async () => {
      mockTradesRepo.findById.mockResolvedValue(inReviewTrade);
      mockRosterRepo.findByLeagueAndUser.mockResolvedValue(thirdRoster);
      mockTradeVotesRepo.hasVoted.mockResolvedValue(true);

      await expect(tradesService.voteTrade(1, 'user-789', 'approve')).rejects.toThrow(
        ConflictException
      );
      await expect(tradesService.voteTrade(1, 'user-789', 'approve')).rejects.toThrow(
        'already voted'
      );
    });

    it('should record vote successfully', async () => {
      mockTradesRepo.findById.mockResolvedValue(inReviewTrade);
      mockRosterRepo.findByLeagueAndUser.mockResolvedValue(thirdRoster);
      mockTradeVotesRepo.hasVoted.mockResolvedValue(false);
      mockTradeVotesRepo.countVotes.mockResolvedValue({ approve: 1, veto: 0 });
      mockLeagueRepo.findById.mockResolvedValue(mockLeague);
      mockTradesRepo.findByIdWithDetails.mockResolvedValue({
        ...mockTradeWithDetails,
        status: 'in_review',
      });

      const result = await tradesService.voteTrade(1, 'user-789', 'approve');

      expect(result.voteCount).toEqual({ approve: 1, veto: 0 });
      expect(mockTradeVotesRepo.create).toHaveBeenCalledWith(1, 3, 'approve', expect.anything());
    });

    it('should veto trade when threshold reached', async () => {
      mockTradesRepo.findById.mockResolvedValue(inReviewTrade);
      mockRosterRepo.findByLeagueAndUser.mockResolvedValue(thirdRoster);
      mockTradeVotesRepo.hasVoted.mockResolvedValue(false);
      mockTradeVotesRepo.countVotes.mockResolvedValue({ approve: 0, veto: 4 });
      mockLeagueRepo.findById.mockResolvedValue(mockLeague);
      mockTradesRepo.updateStatus.mockResolvedValue({ ...inReviewTrade, status: 'vetoed' });
      mockTradesRepo.findByIdWithDetails.mockResolvedValue({
        ...mockTradeWithDetails,
        status: 'vetoed',
      });

      await tradesService.voteTrade(1, 'user-789', 'veto');

      expect(mockTradesRepo.updateStatus).toHaveBeenCalledWith(1, 'vetoed', expect.anything(), 'in_review');
    });
  });

  describe('processExpiredTrades', () => {
    it('should process and expire pending trades past deadline', async () => {
      const expiredTrades = [
        { ...mockTrade, id: 1 },
        { ...mockTrade, id: 2 },
      ];
      mockTradesRepo.findExpiredTrades.mockResolvedValue(expiredTrades);
      // updateStatus now returns the updated trade (or null if condition not met)
      mockTradesRepo.updateStatus.mockResolvedValue({ ...mockTrade, status: 'expired' });

      const count = await tradesService.processExpiredTrades();

      expect(count).toBe(2);
      expect(mockTradesRepo.updateStatus).toHaveBeenCalledTimes(2);
      // Now uses conditional update with expectedStatus='pending'
      expect(mockTradesRepo.updateStatus).toHaveBeenCalledWith(1, 'expired', undefined, 'pending');
      expect(mockTradesRepo.updateStatus).toHaveBeenCalledWith(2, 'expired', undefined, 'pending');
    });
  });

  describe('processReviewCompleteTrades', () => {
    const reviewCompleteTrade = {
      ...mockTrade,
      status: 'in_review' as const,
      reviewStartsAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
      reviewEndsAt: new Date(Date.now() - 1 * 60 * 60 * 1000),
    };

    it('should complete trades without enough vetoes', async () => {
      mockTradesRepo.findReviewCompleteTrades.mockResolvedValue([reviewCompleteTrade]);
      mockTradesRepo.findById.mockResolvedValue(reviewCompleteTrade);
      mockTradeVotesRepo.countVotes.mockResolvedValue({ approve: 2, veto: 1 });
      mockLeagueRepo.findById.mockResolvedValue(mockLeague);
      mockTradeItemsRepo.findByTrade.mockResolvedValue([mockTradeItem]);
      // Setup batch validation mock - player 100 owned by roster 1
      setupBatchValidationMock(mockPoolClient, [{ rosterId: 1, playerIds: [100] }]);
      mockTransactionsRepo.create.mockResolvedValue({ id: 1 } as any);
      mockTradesRepo.updateStatus.mockResolvedValue({ ...reviewCompleteTrade, status: 'completed' });

      const count = await tradesService.processReviewCompleteTrades();

      expect(count).toBe(1);
      expect(mockTradesRepo.updateStatus).toHaveBeenCalledWith(1, 'completed', mockPoolClient, 'in_review');
    });

    it('should veto trades with enough veto votes', async () => {
      mockTradesRepo.findReviewCompleteTrades.mockResolvedValue([reviewCompleteTrade]);
      mockTradeVotesRepo.countVotes.mockResolvedValue({ approve: 0, veto: 4 });
      mockLeagueRepo.findById.mockResolvedValue(mockLeague);
      mockTradesRepo.updateStatus.mockResolvedValue({ ...reviewCompleteTrade, status: 'vetoed' });

      const count = await tradesService.processReviewCompleteTrades();

      expect(count).toBe(1);
      expect(mockTradesRepo.updateStatus).toHaveBeenCalledWith(1, 'vetoed', mockPoolClient, 'in_review');
    });
  });

  describe('getTradesForLeague', () => {
    it('should throw ForbiddenException when not a league member', async () => {
      mockLeagueRepo.isUserMember.mockResolvedValue(false);

      await expect(tradesService.getTradesForLeague(1, 'user-123')).rejects.toThrow(
        ForbiddenException
      );
    });

    it('should return trades for league', async () => {
      mockLeagueRepo.isUserMember.mockResolvedValue(true);
      mockRosterRepo.findByLeagueAndUser.mockResolvedValue(mockRoster);
      mockTradesRepo.findByLeagueWithDetails.mockResolvedValue([mockTradeWithDetails]);

      const result = await tradesService.getTradesForLeague(1, 'user-123');

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(mockTradeWithDetails);
    });
  });

  describe('getTradeById', () => {
    it('should throw NotFoundException when trade not found', async () => {
      mockTradesRepo.findById.mockResolvedValue(null);

      await expect(tradesService.getTradeById(1, 'user-123', 1)).rejects.toThrow(NotFoundException);
    });

    it('should throw NotFoundException when trade does not belong to requested league', async () => {
      mockTradesRepo.findById.mockResolvedValue(mockTrade);

      // Request trade from league 999, but trade belongs to league 1
      await expect(tradesService.getTradeById(1, 'user-123', 999)).rejects.toThrow(NotFoundException);
    });

    it('should throw ForbiddenException when not a league member', async () => {
      mockTradesRepo.findById.mockResolvedValue(mockTrade);
      mockLeagueRepo.isUserMember.mockResolvedValue(false);

      await expect(tradesService.getTradeById(1, 'user-123', 1)).rejects.toThrow(ForbiddenException);
    });

    it('should return trade details', async () => {
      mockTradesRepo.findById.mockResolvedValue(mockTrade);
      mockLeagueRepo.isUserMember.mockResolvedValue(true);
      mockRosterRepo.findByLeagueAndUser.mockResolvedValue(mockRoster);
      mockTradesRepo.findByIdWithDetails.mockResolvedValue(mockTradeWithDetails);

      const result = await tradesService.getTradeById(1, 'user-123', 1);

      expect(result).toEqual(mockTradeWithDetails);
    });
  });
});
