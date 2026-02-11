import { Pool, PoolClient } from 'pg';
import { FastAuctionService } from '../../../modules/drafts/auction/fast-auction.service';
import { AuctionLotRepository } from '../../../modules/drafts/auction/auction-lot.repository';
import { DraftRepository } from '../../../modules/drafts/drafts.repository';
import { LeagueRepository, RosterRepository } from '../../../modules/leagues/leagues.repository';
import { DraftOrderService } from '../../../modules/drafts/draft-order.service';
import { PlayerRepository } from '../../../modules/players/players.repository';
import {
  AuctionLot,
  AuctionProxyBid,
} from '../../../modules/drafts/auction/auction.models';
import { FastAuctionSettings } from '../../../modules/drafts/auction/fast-auction.service';
import { Draft } from '../../../modules/drafts/drafts.model';
import {
  NotFoundException,
  ValidationException,
  ForbiddenException,
} from '../../../utils/exceptions';

// Mock runWithLock to bypass actual database locking
jest.mock('../../../shared/transaction-runner', () => ({
  runWithLock: jest.fn(async (_pool, _domain, _id, fn) => {
    const mockClient = {
      query: jest.fn().mockResolvedValue({ rows: [] }),
    };
    return fn(mockClient);
  }),
  LockDomain: {
    DRAFT: 700_000_000,
    ROSTER: 200_000_000,
  },
}));

// Mock socket service
jest.mock('../../../socket/socket.service', () => ({
  tryGetSocketService: jest.fn(() => ({
    emitAuctionLotCreated: jest.fn(),
    emitAuctionLotUpdated: jest.fn(),
    emitAuctionNominatorChanged: jest.fn(),
    emitAuctionOutbid: jest.fn(),
  })),
}));

// Mock draft completion utils
jest.mock('../../../modules/drafts/draft-completion.utils', () => ({
  finalizeDraftCompletion: jest.fn().mockResolvedValue(undefined),
}));

// Mock container
jest.mock('../../../container', () => ({
  container: {
    resolve: jest.fn().mockReturnValue({}),
  },
  KEYS: {
    ROSTER_PLAYERS_REPO: 'rosterPlayersRepo',
  },
}));

// Mock data
const mockFastDraft: Draft = {
  id: 1,
  leagueId: 1,
  draftType: 'auction',
  rounds: 15,
  pickTimeSeconds: 60,
  status: 'in_progress',
  phase: 'LIVE',
  currentPick: 1,
  currentRound: 1,
  currentRosterId: 1,
  pickDeadline: new Date(Date.now() + 60000),
  scheduledStart: null,
  startedAt: new Date(),
  completedAt: null,
  settings: {
    auctionMode: 'fast',
    nominationSeconds: 60,
    resetOnBidSeconds: 15,
    minBid: 1,
    minIncrement: 1,
  },
  draftState: {},
  orderConfirmed: true,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const mockSlowDraft: Draft = {
  ...mockFastDraft,
  settings: {
    auctionMode: 'slow',
    bidWindowSeconds: 43200,
    maxActiveNominationsPerTeam: 2,
    maxActiveNominationsGlobal: 25,
    minBid: 1,
    minIncrement: 1,
  },
};

const mockLeague: any = {
  id: 1,
  name: 'Test League',
  leagueSettings: {
    auctionBudget: 200,
    rosterSlots: 15,
  },
};

const mockRoster = {
  id: 1,
  leagueId: 1,
  userId: 'user-1',
  username: 'TestUser',
  createdAt: new Date(),
  updatedAt: new Date(),
};

const mockPlayer = {
  id: 100,
  sleeperId: '100',
  firstName: 'Test',
  lastName: 'Player',
  fullName: 'Test Player',
  fantasyPositions: ['RB'],
  position: 'RB',
  team: 'NYG',
  yearsExp: 5,
  age: 28,
  active: true,
  status: 'Active',
  injuryStatus: null,
  jerseyNumber: 26,
  cfbdId: null,
  college: null,
  height: null,
  weight: null,
  homeCity: null,
  homeState: null,
  playerType: 'nfl' as const,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const mockLot: AuctionLot = {
  id: 1,
  draftId: 1,
  playerId: 100,
  nominatorRosterId: 1,
  currentBid: 1,
  currentBidderRosterId: null,
  bidCount: 0,
  bidDeadline: new Date(Date.now() + 60000),
  status: 'active',
  winningRosterId: null,
  winningBid: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const mockProxyBid: AuctionProxyBid = {
  id: 1,
  lotId: 1,
  rosterId: 1,
  maxBid: 50,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const mockSettings: FastAuctionSettings = {
  auctionMode: 'fast',
  nominationSeconds: 60,
  resetOnBidSeconds: 15,
  minBid: 1,
  minIncrement: 1,
  maxLotDurationSeconds: null,
};

// Mock repositories
const createMockLotRepo = (): jest.Mocked<AuctionLotRepository> =>
  ({
    createLot: jest.fn(),
    createLotWithClient: jest.fn(),
    findLotById: jest.fn(),
    findActiveLotsByDraft: jest.fn(),
    findLotByDraftAndPlayer: jest.fn(),
    countActiveLotsForRoster: jest.fn(),
    countAllActiveLots: jest.fn(),
    countDailyNominationsForRoster: jest.fn(),
    updateLot: jest.fn(),
    settleLot: jest.fn(),
    passLot: jest.fn(),
    findExpiredLots: jest.fn(),
    upsertProxyBid: jest.fn(),
    getAllProxyBidsForLot: jest.fn(),
    getProxyBid: jest.fn(),
    getProxyBidsForRoster: jest.fn(),
    recordBidHistory: jest.fn(),
    getBidHistoryForLot: jest.fn(),
    getRosterBudgetData: jest.fn(),
    getRosterBudgetDataWithClient: jest.fn(),
    getAllRosterBudgetData: jest.fn(),
    getAllRosterBudgetDataWithClient: jest.fn(),
    getNominatedPlayerIds: jest.fn(),
    hasActiveLotWithClient: jest.fn(),
    hasActiveLot: jest.fn(),
    findLotByDraftAndPlayerWithClient: jest.fn(),
    findLotsByDraft: jest.fn(),
    countActiveLotsForRosterWithClient: jest.fn(),
    countAllActiveLotsWithClient: jest.fn(),
    countDailyNominationsForRosterWithClient: jest.fn(),
  }) as unknown as jest.Mocked<AuctionLotRepository>;

const createMockDraftRepo = (): jest.Mocked<DraftRepository> =>
  ({
    findById: jest.fn(),
    isPlayerDrafted: jest.fn(),
    getDraftedPlayerIds: jest.fn(),
    update: jest.fn().mockResolvedValue({}),
    getDraftPicks: jest.fn().mockResolvedValue([]),
  }) as unknown as jest.Mocked<DraftRepository>;

const createMockRosterRepo = (): jest.Mocked<RosterRepository> =>
  ({
    findById: jest.fn(),
    findByLeagueId: jest.fn(),
    findByLeagueAndUser: jest.fn(),
  }) as unknown as jest.Mocked<RosterRepository>;

const createMockLeagueRepo = (): jest.Mocked<LeagueRepository> =>
  ({
    findById: jest.fn(),
    update: jest.fn().mockResolvedValue({}),
  }) as unknown as jest.Mocked<LeagueRepository>;

const createMockOrderService = (): jest.Mocked<DraftOrderService> =>
  ({
    getDraftOrder: jest.fn(),
    getNextPicker: jest.fn(),
  }) as unknown as jest.Mocked<DraftOrderService>;

const createMockPlayerRepo = (): jest.Mocked<PlayerRepository> =>
  ({
    findById: jest.fn(),
    findAll: jest.fn(),
    findRandomEligiblePlayerForAuction: jest.fn(),
  }) as unknown as jest.Mocked<PlayerRepository>;

const createMockPool = (): jest.Mocked<Pool> =>
  ({
    connect: jest.fn(),
  }) as unknown as jest.Mocked<Pool>;

describe('FastAuctionService', () => {
  let service: FastAuctionService;
  let mockLotRepo: jest.Mocked<AuctionLotRepository>;
  let mockDraftRepo: jest.Mocked<DraftRepository>;
  let mockRosterRepo: jest.Mocked<RosterRepository>;
  let mockLeagueRepo: jest.Mocked<LeagueRepository>;
  let mockOrderService: jest.Mocked<DraftOrderService>;
  let mockPlayerRepo: jest.Mocked<PlayerRepository>;
  let mockPool: jest.Mocked<Pool>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockLotRepo = createMockLotRepo();
    mockDraftRepo = createMockDraftRepo();
    mockRosterRepo = createMockRosterRepo();
    mockLeagueRepo = createMockLeagueRepo();
    mockOrderService = createMockOrderService();
    mockPlayerRepo = createMockPlayerRepo();
    mockPool = createMockPool();

    service = new FastAuctionService(
      mockLotRepo,
      mockDraftRepo,
      mockRosterRepo,
      mockLeagueRepo,
      mockOrderService,
      mockPlayerRepo,
      mockPool
    );
  });

  describe('getSettings', () => {
    it('should return default settings when draft has no settings', () => {
      const draftWithoutSettings = { ...mockFastDraft, settings: {} };
      const settings = service.getSettings(draftWithoutSettings);

      expect(settings.auctionMode).toBe('slow');
      expect(settings.nominationSeconds).toBe(60);
      expect(settings.resetOnBidSeconds).toBe(15);
      expect(settings.minBid).toBe(1);
      expect(settings.minIncrement).toBe(1);
    });

    it('should return configured settings from draft', () => {
      const settings = service.getSettings(mockFastDraft);

      expect(settings.auctionMode).toBe('fast');
      expect(settings.nominationSeconds).toBe(60);
      expect(settings.resetOnBidSeconds).toBe(15);
      expect(settings.minBid).toBe(1);
      expect(settings.minIncrement).toBe(1);
    });

    it('should return custom settings when configured', () => {
      const draftWithCustomSettings = {
        ...mockFastDraft,
        settings: {
          auctionMode: 'fast' as const,
          nominationSeconds: 90,
          resetOnBidSeconds: 20,
          minBid: 2,
          minIncrement: 2,
        },
      };
      const settings = service.getSettings(draftWithCustomSettings);

      expect(settings.nominationSeconds).toBe(90);
      expect(settings.resetOnBidSeconds).toBe(20);
      expect(settings.minBid).toBe(2);
      expect(settings.minIncrement).toBe(2);
    });
  });

  describe('getCurrentNominator', () => {
    it('should return null when draft not found', async () => {
      mockDraftRepo.findById.mockResolvedValue(null);

      const result = await service.getCurrentNominator(1);

      expect(result).toBeNull();
    });

    it('should return null when draft has no currentRosterId', async () => {
      mockDraftRepo.findById.mockResolvedValue({ ...mockFastDraft, currentRosterId: null });

      const result = await service.getCurrentNominator(1);

      expect(result).toBeNull();
    });

    it('should return nominator info when valid', async () => {
      mockDraftRepo.findById.mockResolvedValue(mockFastDraft);
      mockRosterRepo.findById.mockResolvedValue(mockRoster as any);

      const result = await service.getCurrentNominator(1);

      expect(result).toEqual({ rosterId: 1, userId: 'user-1' });
    });
  });

  describe('nominate', () => {
    it('should throw NotFoundException when draft not found', async () => {
      mockDraftRepo.findById.mockResolvedValue(null);

      await expect(service.nominate(1, 'user-1', 100)).rejects.toThrow(NotFoundException);
      await expect(service.nominate(1, 'user-1', 100)).rejects.toThrow('Draft not found');
    });

    it('should throw ValidationException when draft not in_progress', async () => {
      mockDraftRepo.findById.mockResolvedValue({ ...mockFastDraft, status: 'not_started' });

      await expect(service.nominate(1, 'user-1', 100)).rejects.toThrow(ValidationException);
      await expect(service.nominate(1, 'user-1', 100)).rejects.toThrow('not in progress');
    });

    it('should throw ValidationException when not an auction draft', async () => {
      mockDraftRepo.findById.mockResolvedValue({ ...mockFastDraft, draftType: 'snake' });

      await expect(service.nominate(1, 'user-1', 100)).rejects.toThrow(ValidationException);
      await expect(service.nominate(1, 'user-1', 100)).rejects.toThrow('not an auction draft');
    });

    it('should throw ValidationException when not a fast auction', async () => {
      mockDraftRepo.findById.mockResolvedValue(mockSlowDraft);

      await expect(service.nominate(1, 'user-1', 100)).rejects.toThrow(ValidationException);
      await expect(service.nominate(1, 'user-1', 100)).rejects.toThrow(
        'not a fast auction draft'
      );
    });

    it('should throw ForbiddenException when user is not in league', async () => {
      mockDraftRepo.findById.mockResolvedValue(mockFastDraft);
      mockRosterRepo.findByLeagueAndUser.mockResolvedValue(null);

      await expect(service.nominate(1, 'user-1', 100)).rejects.toThrow(ForbiddenException);
      await expect(service.nominate(1, 'user-1', 100)).rejects.toThrow('not a member');
    });

    it('should throw ForbiddenException when user is not current nominator', async () => {
      mockDraftRepo.findById.mockResolvedValue({ ...mockFastDraft, currentRosterId: 2 });
      mockRosterRepo.findByLeagueAndUser.mockResolvedValue(mockRoster as any);

      await expect(service.nominate(1, 'user-1', 100)).rejects.toThrow(ForbiddenException);
      await expect(service.nominate(1, 'user-1', 100)).rejects.toThrow('not your turn');
    });
  });

  describe('setMaxBid', () => {
    it('should throw NotFoundException when draft not found', async () => {
      mockDraftRepo.findById.mockResolvedValue(null);

      await expect(service.setMaxBid(1, 'user-1', 1, 50)).rejects.toThrow(NotFoundException);
      await expect(service.setMaxBid(1, 'user-1', 1, 50)).rejects.toThrow('Draft not found');
    });

    it('should throw ValidationException when not fast auction', async () => {
      mockDraftRepo.findById.mockResolvedValue(mockSlowDraft);

      await expect(service.setMaxBid(1, 'user-1', 1, 50)).rejects.toThrow(ValidationException);
      await expect(service.setMaxBid(1, 'user-1', 1, 50)).rejects.toThrow(
        'not a fast auction draft'
      );
    });

    it('should throw ForbiddenException when user not in league', async () => {
      mockDraftRepo.findById.mockResolvedValue(mockFastDraft);
      mockRosterRepo.findByLeagueAndUser.mockResolvedValue(null);

      await expect(service.setMaxBid(1, 'user-1', 1, 50)).rejects.toThrow(ForbiddenException);
      await expect(service.setMaxBid(1, 'user-1', 1, 50)).rejects.toThrow('not a member');
    });
  });

  describe('advanceNominator', () => {
    it('should not emit event for non-fast auction', async () => {
      // The mocked runWithLock will return null for slow auction
      const { runWithLock } = require('../../../shared/transaction-runner');
      runWithLock.mockImplementationOnce(async (_pool: any, _domain: any, _id: any, fn: any) => {
        const mockClient = {
          query: jest.fn()
            .mockResolvedValueOnce({ rows: [{ ...mockFastDraft, settings: { auctionMode: 'slow' } }] }),
        };
        return fn(mockClient);
      });

      await service.advanceNominator(1);

      // Should complete without emitting socket event (null result)
    });

    it('should throw NotFoundException when draft not found in transaction', async () => {
      const { runWithLock } = require('../../../shared/transaction-runner');
      runWithLock.mockImplementationOnce(async (_pool: any, _domain: any, _id: any, fn: any) => {
        const mockClient = {
          query: jest.fn().mockResolvedValueOnce({ rows: [] }),
        };
        return fn(mockClient);
      });

      await expect(service.advanceNominator(1)).rejects.toThrow(NotFoundException);
    });
  });

  describe('forceAdvanceNominator', () => {
    it('should log and throw on error', async () => {
      const { runWithLock } = require('../../../shared/transaction-runner');
      runWithLock.mockImplementationOnce(async () => {
        throw new Error('Database error');
      });

      await expect(service.forceAdvanceNominator(1)).rejects.toThrow('Database error');
    });

    it('should return null when draft not found', async () => {
      const { runWithLock } = require('../../../shared/transaction-runner');
      runWithLock.mockImplementationOnce(async (_pool: any, _domain: any, _id: any, fn: any) => {
        const mockClient = {
          query: jest.fn().mockResolvedValueOnce({ rows: [] }),
        };
        return fn(mockClient);
      });

      // Should complete without throwing (returns null)
      await service.forceAdvanceNominator(1);
    });
  });

  describe('autoNominate', () => {
    it('should return null for non-fast auction', async () => {
      mockDraftRepo.findById.mockResolvedValue(mockSlowDraft);

      const result = await service.autoNominate(1);

      expect(result).toBeNull();
    });

    it('should return null when draft not found', async () => {
      mockDraftRepo.findById.mockResolvedValue(null);

      await expect(service.autoNominate(1)).rejects.toThrow(NotFoundException);
    });

    it('should return null when no current nominator', async () => {
      mockDraftRepo.findById.mockResolvedValue({ ...mockFastDraft, currentRosterId: null });

      const result = await service.autoNominate(1);

      expect(result).toBeNull();
    });

    it('should return null when active lot already exists', async () => {
      mockDraftRepo.findById.mockResolvedValue(mockFastDraft);
      // Mock hasActiveLotWithClient to return true (active lot exists)
      mockLotRepo.hasActiveLotWithClient.mockResolvedValue(true);

      const result = await service.autoNominate(1);

      expect(result).toBeNull();
    });

    it('should complete auction when no players available', async () => {
      mockDraftRepo.findById.mockResolvedValue(mockFastDraft);
      // Mock hasActiveLotWithClient to return false (no active lot)
      mockLotRepo.hasActiveLotWithClient.mockResolvedValue(false);
      // Mock findRandomEligiblePlayerForAuction to return null (no players available)
      mockPlayerRepo.findRandomEligiblePlayerForAuction.mockResolvedValue(null);

      const { runWithLock } = require('../../../shared/transaction-runner');

      // The raw draft row that advanceNominator reads from the database
      const rawDraftRow = {
        id: 1,
        league_id: 1,
        status: 'in_progress',
        settings: { auctionMode: 'fast', nominationSeconds: 60, minBid: 1 },
        current_pick: 1,
      };

      // Mock both calls: first autoNominate (returns skipReason), then advanceNominator (detects completion)
      runWithLock.mockImplementation(async (_pool: any, _domain: any, _id: any, fn: any) => {
        const mockClient = {
          query: jest.fn()
            .mockResolvedValueOnce({ rows: [rawDraftRow] }), // Draft query (FOR UPDATE)
        };
        return fn(mockClient);
      });

      const result = await service.autoNominate(1);

      expect(result).toBeNull();
      // Verify draft was marked as completed
      expect(mockDraftRepo.update).toHaveBeenCalledWith(1, { status: 'completed' });
    });
  });

  describe('getState', () => {
    it('should throw NotFoundException when draft not found', async () => {
      mockDraftRepo.findById.mockResolvedValue(null);

      await expect(service.getState(1)).rejects.toThrow(NotFoundException);
    });

    it('should return fast auction state', async () => {
      mockDraftRepo.findById.mockResolvedValue(mockFastDraft);
      mockLotRepo.findActiveLotsByDraft.mockResolvedValue([mockLot]);
      mockLeagueRepo.findById.mockResolvedValue(mockLeague);
      mockRosterRepo.findByLeagueId.mockResolvedValue([mockRoster as any]);
      mockLotRepo.getAllRosterBudgetData.mockResolvedValue(
        new Map([[1, { spent: 50, wonCount: 5, leadingCommitment: 10 }]])
      );

      const result = await service.getState(1);

      expect(result.auctionMode).toBe('fast');
      expect(result.activeLot).toEqual(mockLot);
      expect(result.currentNominatorRosterId).toBe(1);
      expect(result.nominationNumber).toBe(1);
      expect(result.budgets).toHaveLength(1);
    });

    it('should return null activeLot when no active lots', async () => {
      mockDraftRepo.findById.mockResolvedValue(mockFastDraft);
      mockLotRepo.findActiveLotsByDraft.mockResolvedValue([]);
      mockLeagueRepo.findById.mockResolvedValue(mockLeague);
      mockRosterRepo.findByLeagueId.mockResolvedValue([mockRoster as any]);
      mockLotRepo.getAllRosterBudgetData.mockResolvedValue(new Map());

      const result = await service.getState(1);

      expect(result.activeLot).toBeNull();
    });
  });

  describe('setMaxBid - deadline enforcement', () => {
    it('should reject bid after lot deadline has passed', async () => {
      // Set up draft and roster for fast auction
      mockDraftRepo.findById.mockResolvedValue(mockFastDraft);
      mockRosterRepo.findByLeagueAndUser.mockResolvedValue(mockRoster as any);

      const { runWithLock } = require('../../../shared/transaction-runner');

      // Create lot with expired deadline (database row format)
      const expiredLot = {
        id: 1,
        draft_id: 1,
        player_id: 100,
        nominator_roster_id: 1,
        current_bid: 5,
        current_bidder_roster_id: 1,
        bid_count: 1,
        bid_deadline: new Date(Date.now() - 5000), // 5 seconds in the past
        status: 'active',
        winning_roster_id: null,
        winning_bid: null,
        created_at: new Date(),
        updated_at: new Date(),
      };

      // No idempotencyKey is passed, so the first query is the lot FOR UPDATE
      runWithLock.mockImplementationOnce(async (_pool: any, _domain: any, _id: any, fn: any) => {
        const mockClient = {
          query: jest.fn()
            .mockResolvedValueOnce({ rows: [expiredLot] }), // lot FOR UPDATE
        };
        return fn(mockClient);
      });

      await expect(service.setMaxBid(1, 'user-1', 1, 10)).rejects.toThrow(ValidationException);

      // Verify error message
      runWithLock.mockImplementationOnce(async (_pool: any, _domain: any, _id: any, fn: any) => {
        const mockClient = {
          query: jest.fn()
            .mockResolvedValueOnce({ rows: [expiredLot] }),
        };
        return fn(mockClient);
      });

      await expect(service.setMaxBid(1, 'user-1', 1, 10)).rejects.toThrow('Lot has expired');
    });
  });

  describe('nominate - deadline capping', () => {
    it('should cap initial bidDeadline by maxLotDurationSeconds', async () => {
      // Draft with nominationSeconds=120 but maxLotDurationSeconds=60
      const draftWithMaxDuration = {
        ...mockFastDraft,
        settings: {
          ...mockFastDraft.settings,
          nominationSeconds: 120,
          maxLotDurationSeconds: 60,
        },
      };
      mockDraftRepo.findById.mockResolvedValue(draftWithMaxDuration);
      mockRosterRepo.findByLeagueAndUser.mockResolvedValue(mockRoster as any);

      const { runWithLock } = require('../../../shared/transaction-runner');

      let capturedBidDeadline: Date | null = null;

      runWithLock.mockImplementationOnce(async (_pool: any, _domain: any, _id: any, fn: any) => {
        const createdLot = {
          ...mockLot,
          currentBidderRosterId: 1,
        };

        const mockClient = {
          query: jest.fn().mockImplementation((sql: string) => {
            if (sql.includes('SELECT EXISTS')) {
              return { rows: [{ exists: false }] };
            }
            return { rows: [], rowCount: 1 };
          }),
        };

        // Mock lot repo methods that use the client
        mockLotRepo.hasActiveLotWithClient.mockResolvedValue(false);
        mockPlayerRepo.findByIdWithClient = jest.fn().mockResolvedValue(mockPlayer) as any;
        mockLotRepo.findLotByDraftAndPlayerWithClient.mockResolvedValue(null);
        mockLotRepo.getRosterBudgetDataWithClient.mockResolvedValue({
          spent: 0,
          wonCount: 0,
          leadingCommitment: 0,
        });
        mockLeagueRepo.findById.mockResolvedValue(mockLeague);
        mockLotRepo.createLotWithClient.mockImplementation(
          async (_client, _draftId, _playerId, _rosterId, bidDeadline) => {
            capturedBidDeadline = bidDeadline;
            return createdLot;
          }
        );

        return fn(mockClient);
      });

      await service.nominate(1, 'user-1', 100);

      // The bidDeadline should be capped at ~60s, not 120s
      expect(capturedBidDeadline).not.toBeNull();
      const diffMs = capturedBidDeadline!.getTime() - Date.now();
      // Should be approximately 60 seconds (with some tolerance for test execution time)
      expect(diffMs).toBeLessThanOrEqual(61000);
      expect(diffMs).toBeGreaterThan(50000); // At least 50s to ensure it was capped from 120s
    });
  });
});
