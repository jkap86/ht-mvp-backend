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

// Mock event bus for verifying event emission
const mockEventBus = {
  publish: jest.fn(),
};

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
    AUCTION: 500_000_000,
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
const mockFinalizeDraftCompletion = jest.fn().mockResolvedValue(undefined);
jest.mock('../../../modules/drafts/draft-completion.utils', () => ({
  finalizeDraftCompletion: (...args: any[]) => mockFinalizeDraftCompletion(...args),
}));

// Mock container
jest.mock('../../../container', () => ({
  container: {
    resolve: jest.fn().mockReturnValue({}),
    tryResolve: jest.fn().mockReturnValue(null),
  },
  KEYS: {
    ROSTER_PLAYERS_REPO: 'rosterPlayersRepo',
    DOMAIN_EVENT_BUS: 'domainEventBus',
  },
}));

// Mock shared events to return our mock event bus
jest.mock('../../../shared/events', () => ({
  tryGetEventBus: jest.fn(() => mockEventBus),
  EventTypes: {
    AUCTION_LOT_STARTED: 'auction:lot_started',
    AUCTION_BID: 'auction:bid',
    AUCTION_OUTBID: 'auction:outbid',
    AUCTION_NOMINATOR_CHANGED: 'auction:nominator_changed',
    DRAFT_COMPLETED: 'draft:completed',
  },
}));

// Mock price resolver
const mockResolvePriceWithClient = jest.fn();
jest.mock('../../../modules/drafts/auction/auction-price-resolver', () => ({
  resolvePriceWithClient: (...args: any[]) => mockResolvePriceWithClient(...args),
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
  rosterPopulationStatus: null,
  overnightPauseEnabled: false,
  overnightPauseStart: null,
  overnightPauseEnd: null,
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
  activeLeagueSeasonId: 1,
};

const mockRoster = {
  id: 1,
  leagueId: 1,
  userId: 'user-1',
  username: 'TestUser',
  createdAt: new Date(),
  updatedAt: new Date(),
};

const mockRoster2 = {
  id: 2,
  leagueId: 1,
  userId: 'user-2',
  username: 'TestUser2',
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
  fastAuctionTimeoutAction: 'auto_nominate_and_open_bid',
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
    findByIds: jest.fn().mockResolvedValue([]),
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
    findByIdWithClient: jest.fn(),
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

    it('should create lot and emit AUCTION_LOT_STARTED event on successful nomination', async () => {
      mockDraftRepo.findById.mockResolvedValue(mockFastDraft);
      mockRosterRepo.findByLeagueAndUser.mockResolvedValue(mockRoster as any);

      const { runWithLock } = require('../../../shared/transaction-runner');

      const createdLot: AuctionLot = {
        ...mockLot,
        currentBidderRosterId: 1,
        currentBid: 1,
      };

      runWithLock.mockImplementationOnce(async (_pool: any, _domain: any, _id: any, fn: any) => {
        const mockClient = {
          query: jest.fn().mockImplementation((sql: string) => {
            // Draft FOR UPDATE re-validation
            if (sql.includes('FROM drafts WHERE') && sql.includes('FOR UPDATE')) {
              return {
                rows: [{
                  status: 'in_progress',
                  settings: { auctionMode: 'fast', nominationSeconds: 60, minBid: 1, minIncrement: 1 },
                  current_roster_id: 1,
                }],
              };
            }
            // Player drafted check
            if (sql.includes('SELECT EXISTS')) {
              return { rows: [{ exists: false }] };
            }
            // Opening bidder updates (UPDATE auction_lots, INSERT proxy, INSERT bid history)
            return { rows: [], rowCount: 1 };
          }),
        };

        mockLotRepo.hasActiveLotWithClient.mockResolvedValue(false);
        mockPlayerRepo.findByIdWithClient.mockResolvedValue(mockPlayer as any);
        mockLotRepo.findLotByDraftAndPlayerWithClient.mockResolvedValue(null);
        mockLotRepo.getRosterBudgetDataWithClient.mockResolvedValue({
          spent: 0,
          wonCount: 0,
          leadingCommitment: 0,
        });
        mockLeagueRepo.findById.mockResolvedValue(mockLeague);
        mockLotRepo.createLotWithClient.mockResolvedValue(createdLot);

        return fn(mockClient);
      });

      const result = await service.nominate(1, 'user-1', 100);

      expect(result.lot).toBeDefined();
      expect(result.lot.currentBidderRosterId).toBe(1);
      expect(result.message).toContain('Test Player');
      expect(result.message).toContain('$1');

      // Verify event was published
      expect(mockEventBus.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'auction:lot_started',
          payload: expect.objectContaining({
            draftId: 1,
            serverTime: expect.any(Number),
          }),
        })
      );

      // Verify lot was created with client
      expect(mockLotRepo.createLotWithClient).toHaveBeenCalled();
    });

    it('should return existing lot when idempotency key matches (idempotent nomination via ON CONFLICT)', async () => {
      mockDraftRepo.findById.mockResolvedValue(mockFastDraft);
      mockRosterRepo.findByLeagueAndUser.mockResolvedValue(mockRoster as any);

      const { runWithLock } = require('../../../shared/transaction-runner');

      const existingLot = {
        id: 1,
        draftId: 1,
        playerId: 100,
        nominatorRosterId: 1,
        currentBid: 5,
        currentBidderRosterId: 1,
        bidCount: 0,
        bidDeadline: new Date(Date.now() + 60000),
        status: 'active' as const,
        winningRosterId: null,
        winningBid: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      runWithLock.mockImplementationOnce(async (_pool: any, _domain: any, _id: any, fn: any) => {
        const mockClient = {
          query: jest.fn().mockImplementation((sql: string) => {
            // Draft state check
            if (sql.includes('SELECT status, settings, current_roster_id')) {
              return { rows: [{
                status: 'in_progress',
                settings: { auctionMode: 'fast', nominationSeconds: 60, minBid: 1, minIncrement: 1 },
                current_roster_id: 1,
              }] };
            }
            // Player drafted check
            if (sql.includes('SELECT EXISTS')) {
              return { rows: [{ exists: false }] };
            }
            // Opening bidder updates
            return { rows: [], rowCount: 1 };
          }),
        };

        // createLotWithClient returns existing lot (ON CONFLICT re-select)
        mockLotRepo.createLotWithClient.mockResolvedValue(existingLot);
        mockLotRepo.hasActiveLotWithClient.mockResolvedValue(false);
        mockPlayerRepo.findByIdWithClient.mockResolvedValue(mockPlayer as any);
        mockLotRepo.findLotByDraftAndPlayerWithClient.mockResolvedValue(null);
        mockLotRepo.getRosterBudgetDataWithClient.mockResolvedValue({
          spent: 0,
          wonCount: 0,
          leadingCommitment: 0,
        });
        mockLeagueRepo.findById.mockResolvedValue(mockLeague);

        return fn(mockClient);
      });

      const result = await service.nominate(1, 'user-1', 100, 'idempotency-key-123');

      expect(result.lot).toBeDefined();
      expect(result.lot.id).toBe(1);
      // createLotWithClient is called but returns existing lot via ON CONFLICT
      expect(mockLotRepo.createLotWithClient).toHaveBeenCalled();
    });

    it('should reject nomination when budget is exceeded', async () => {
      mockDraftRepo.findById.mockResolvedValue(mockFastDraft);
      mockRosterRepo.findByLeagueAndUser.mockResolvedValue(mockRoster as any);

      const { runWithLock } = require('../../../shared/transaction-runner');

      runWithLock.mockImplementationOnce(async (_pool: any, _domain: any, _id: any, fn: any) => {
        const mockClient = {
          query: jest.fn().mockImplementation((sql: string) => {
            if (sql.includes('FROM drafts WHERE') && sql.includes('FOR UPDATE')) {
              return {
                rows: [{
                  status: 'in_progress',
                  settings: { auctionMode: 'fast', nominationSeconds: 60, minBid: 1, minIncrement: 1 },
                  current_roster_id: 1,
                }],
              };
            }
            if (sql.includes('SELECT EXISTS')) {
              return { rows: [{ exists: false }] };
            }
            return { rows: [], rowCount: 1 };
          }),
        };

        mockLotRepo.hasActiveLotWithClient.mockResolvedValue(false);
        mockPlayerRepo.findByIdWithClient.mockResolvedValue(mockPlayer as any);
        mockLotRepo.findLotByDraftAndPlayerWithClient.mockResolvedValue(null);
        // Budget exhausted: spent 200, total budget is 200
        mockLotRepo.getRosterBudgetDataWithClient.mockResolvedValue({
          spent: 200,
          wonCount: 14,
          leadingCommitment: 0,
        });
        mockLeagueRepo.findById.mockResolvedValue(mockLeague);

        return fn(mockClient);
      });

      await expect(service.nominate(1, 'user-1', 100)).rejects.toThrow(ValidationException);
      await expect(
        (async () => {
          const { runWithLock: rwl } = require('../../../shared/transaction-runner');
          rwl.mockImplementationOnce(async (_pool: any, _domain: any, _id: any, fn: any) => {
            const mockClient = {
              query: jest.fn().mockImplementation((sql: string) => {
                if (sql.includes('FROM drafts WHERE') && sql.includes('FOR UPDATE')) {
                  return {
                    rows: [{
                      status: 'in_progress',
                      settings: { auctionMode: 'fast', nominationSeconds: 60, minBid: 1, minIncrement: 1 },
                      current_roster_id: 1,
                    }],
                  };
                }
                if (sql.includes('SELECT EXISTS')) {
                  return { rows: [{ exists: false }] };
                }
                return { rows: [], rowCount: 1 };
              }),
            };

            mockLotRepo.hasActiveLotWithClient.mockResolvedValue(false);
            mockPlayerRepo.findByIdWithClient.mockResolvedValue(mockPlayer as any);
            mockLotRepo.findLotByDraftAndPlayerWithClient.mockResolvedValue(null);
            mockLotRepo.getRosterBudgetDataWithClient.mockResolvedValue({
              spent: 200,
              wonCount: 14,
              leadingCommitment: 0,
            });
            mockLeagueRepo.findById.mockResolvedValue(mockLeague);

            return fn(mockClient);
          });
          await service.nominate(1, 'user-1', 100);
        })()
      ).rejects.toThrow('insufficient budget');
    });

    it('should reject nomination when player already drafted or nominated', async () => {
      mockDraftRepo.findById.mockResolvedValue(mockFastDraft);
      mockRosterRepo.findByLeagueAndUser.mockResolvedValue(mockRoster as any);

      const { runWithLock } = require('../../../shared/transaction-runner');

      // Test player already drafted
      runWithLock.mockImplementationOnce(async (_pool: any, _domain: any, _id: any, fn: any) => {
        const mockClient = {
          query: jest.fn().mockImplementation((sql: string) => {
            if (sql.includes('FROM drafts WHERE') && sql.includes('FOR UPDATE')) {
              return {
                rows: [{
                  status: 'in_progress',
                  settings: { auctionMode: 'fast', nominationSeconds: 60, minBid: 1, minIncrement: 1 },
                  current_roster_id: 1,
                }],
              };
            }
            if (sql.includes('SELECT EXISTS')) {
              return { rows: [{ exists: true }] }; // Player already drafted
            }
            return { rows: [], rowCount: 1 };
          }),
        };

        mockLotRepo.hasActiveLotWithClient.mockResolvedValue(false);
        mockPlayerRepo.findByIdWithClient.mockResolvedValue(mockPlayer as any);

        return fn(mockClient);
      });

      await expect(service.nominate(1, 'user-1', 100)).rejects.toThrow('already been drafted');

      // Test player already nominated (has existing lot)
      runWithLock.mockImplementationOnce(async (_pool: any, _domain: any, _id: any, fn: any) => {
        const mockClient = {
          query: jest.fn().mockImplementation((sql: string) => {
            if (sql.includes('FROM drafts WHERE') && sql.includes('FOR UPDATE')) {
              return {
                rows: [{
                  status: 'in_progress',
                  settings: { auctionMode: 'fast', nominationSeconds: 60, minBid: 1, minIncrement: 1 },
                  current_roster_id: 1,
                }],
              };
            }
            if (sql.includes('SELECT EXISTS')) {
              return { rows: [{ exists: false }] };
            }
            return { rows: [], rowCount: 1 };
          }),
        };

        mockLotRepo.hasActiveLotWithClient.mockResolvedValue(false);
        mockPlayerRepo.findByIdWithClient.mockResolvedValue(mockPlayer as any);
        mockLotRepo.findLotByDraftAndPlayerWithClient.mockResolvedValue(mockLot); // Already nominated

        return fn(mockClient);
      });

      await expect(service.nominate(1, 'user-1', 100)).rejects.toThrow('already been nominated');
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

    it('should resolve price and reset timer on successful bid', async () => {
      mockDraftRepo.findById.mockResolvedValue(mockFastDraft);
      mockRosterRepo.findByLeagueAndUser.mockResolvedValue(mockRoster2 as any);

      const { runWithLock } = require('../../../shared/transaction-runner');

      const lotCreatedAt = new Date();
      const activeLotRow = {
        id: 1,
        draft_id: 1,
        player_id: 100,
        nominator_roster_id: 1,
        current_bid: 5,
        current_bidder_roster_id: 1,
        bid_count: 1,
        bid_deadline: new Date(Date.now() + 30000),
        status: 'active',
        winning_roster_id: null,
        winning_bid: null,
        created_at: lotCreatedAt,
        updated_at: new Date(),
      };

      const updatedLot: AuctionLot = {
        id: 1,
        draftId: 1,
        playerId: 100,
        nominatorRosterId: 1,
        currentBid: 10,
        currentBidderRosterId: 2,
        bidCount: 2,
        bidDeadline: new Date(Date.now() + 15000), // reset timer
        status: 'active',
        winningRosterId: null,
        winningBid: null,
        createdAt: lotCreatedAt,
        updatedAt: new Date(),
      };

      runWithLock.mockImplementationOnce(async (_pool: any, _domain: any, _id: any, fn: any) => {
        const mockClient = {
          query: jest.fn().mockImplementation((sql: string) => {
            // Lot FOR UPDATE
            if (sql.includes('FROM auction_lots WHERE id') && sql.includes('FOR UPDATE')) {
              return { rows: [activeLotRow] };
            }
            // Roster membership re-check
            if (sql.includes('FROM rosters WHERE league_id')) {
              return { rows: [{ id: 2 }] };
            }
            // All other queries (INSERT proxy bid, INSERT bid history, UPDATE deadline)
            return { rows: [], rowCount: 1 };
          }),
        };

        mockLeagueRepo.findById.mockResolvedValue(mockLeague);
        mockLotRepo.getRosterBudgetDataWithClient.mockResolvedValue({
          spent: 0,
          wonCount: 0,
          leadingCommitment: 0,
        });

        // Mock price resolution: price changed and leader changed
        mockResolvePriceWithClient.mockResolvedValue({
          updatedLot,
          outbidNotifications: [{ rosterId: 1, lotId: 1, previousBid: 5, newLeadingBid: 10 }],
          leaderChanged: true,
          priceChanged: true,
        });

        return fn(mockClient);
      });

      // Mock getProxyBid for response building
      mockLotRepo.getProxyBid.mockResolvedValue(mockProxyBid);
      // Mock findByIds for outbid notification roster lookup
      mockRosterRepo.findByIds.mockResolvedValue([mockRoster as any]);

      const result = await service.setMaxBid(1, 'user-2', 1, 50);

      expect(result.lot.currentBid).toBe(10);
      expect(result.lot.currentBidderRosterId).toBe(2);
      expect(result.message).toContain('$50');

      // Verify event was published
      expect(mockEventBus.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'auction:bid',
          payload: expect.objectContaining({
            draftId: 1,
            serverTime: expect.any(Number),
          }),
        })
      );

      // Verify price resolver was called
      expect(mockResolvePriceWithClient).toHaveBeenCalled();
    });

    it('should cap timer by maxLotDurationSeconds on bids', async () => {
      const draftWithMaxDuration = {
        ...mockFastDraft,
        settings: {
          ...mockFastDraft.settings,
          resetOnBidSeconds: 15,
          maxLotDurationSeconds: 30,
        },
      };
      mockDraftRepo.findById.mockResolvedValue(draftWithMaxDuration);
      mockRosterRepo.findByLeagueAndUser.mockResolvedValue(mockRoster2 as any);

      const { runWithLock } = require('../../../shared/transaction-runner');

      // Lot was created 25 seconds ago, so max deadline is createdAt + 30s = 5s from now
      const lotCreatedAt = new Date(Date.now() - 25000);
      const activeLotRow = {
        id: 1,
        draft_id: 1,
        player_id: 100,
        nominator_roster_id: 1,
        current_bid: 5,
        current_bidder_roster_id: 1,
        bid_count: 1,
        bid_deadline: new Date(Date.now() + 3000), // 3 seconds remaining
        status: 'active',
        winning_roster_id: null,
        winning_bid: null,
        created_at: lotCreatedAt,
        updated_at: new Date(),
      };

      let capturedDeadlineUpdate: Date | null = null;

      const updatedLotWithOldDeadline: AuctionLot = {
        id: 1,
        draftId: 1,
        playerId: 100,
        nominatorRosterId: 1,
        currentBid: 10,
        currentBidderRosterId: 2,
        bidCount: 2,
        bidDeadline: new Date(Date.now() + 3000), // unchanged from lot
        status: 'active',
        winningRosterId: null,
        winningBid: null,
        createdAt: lotCreatedAt,
        updatedAt: new Date(),
      };

      runWithLock.mockImplementationOnce(async (_pool: any, _domain: any, _id: any, fn: any) => {
        const mockClient = {
          query: jest.fn().mockImplementation((sql: string, params?: any[]) => {
            if (sql.includes('FROM auction_lots WHERE id') && sql.includes('FOR UPDATE')) {
              return { rows: [activeLotRow] };
            }
            if (sql.includes('FROM rosters WHERE league_id')) {
              return { rows: [{ id: 2 }] };
            }
            // Capture the deadline update
            if (sql.includes('UPDATE auction_lots SET bid_deadline')) {
              capturedDeadlineUpdate = params?.[0];
              return { rows: [], rowCount: 1 };
            }
            return { rows: [], rowCount: 1 };
          }),
        };

        mockLeagueRepo.findById.mockResolvedValue(mockLeague);
        mockLotRepo.getRosterBudgetDataWithClient.mockResolvedValue({
          spent: 0,
          wonCount: 0,
          leadingCommitment: 0,
        });

        mockResolvePriceWithClient.mockResolvedValue({
          updatedLot: updatedLotWithOldDeadline,
          outbidNotifications: [],
          leaderChanged: true,
          priceChanged: true,
        });

        return fn(mockClient);
      });

      mockLotRepo.getProxyBid.mockResolvedValue(mockProxyBid);

      const result = await service.setMaxBid(1, 'user-2', 1, 50);

      // The new deadline should be capped at createdAt + 30s (~5s from now),
      // not resetOnBidSeconds (15s from now)
      expect(capturedDeadlineUpdate).not.toBeNull();
      const maxAllowed = lotCreatedAt.getTime() + 30000;
      expect(capturedDeadlineUpdate!.getTime()).toBeLessThanOrEqual(maxAllowed + 1000);
    });

    it('should not reset timer when leader raises their max bid', async () => {
      mockDraftRepo.findById.mockResolvedValue(mockFastDraft);
      mockRosterRepo.findByLeagueAndUser.mockResolvedValue(mockRoster as any);

      const { runWithLock } = require('../../../shared/transaction-runner');

      const activeLotRow = {
        id: 1,
        draft_id: 1,
        player_id: 100,
        nominator_roster_id: 1,
        current_bid: 5,
        current_bidder_roster_id: 1, // roster 1 is already leading
        bid_count: 1,
        bid_deadline: new Date(Date.now() + 30000),
        status: 'active',
        winning_roster_id: null,
        winning_bid: null,
        created_at: new Date(),
        updated_at: new Date(),
      };

      const unchangedLot: AuctionLot = {
        id: 1,
        draftId: 1,
        playerId: 100,
        nominatorRosterId: 1,
        currentBid: 5, // price did not change
        currentBidderRosterId: 1, // leader did not change
        bidCount: 1,
        bidDeadline: new Date(Date.now() + 30000),
        status: 'active',
        winningRosterId: null,
        winningBid: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      let deadlineUpdateCalled = false;

      runWithLock.mockImplementationOnce(async (_pool: any, _domain: any, _id: any, fn: any) => {
        const mockClient = {
          query: jest.fn().mockImplementation((sql: string) => {
            if (sql.includes('FROM auction_lots WHERE id') && sql.includes('FOR UPDATE')) {
              return { rows: [activeLotRow] };
            }
            if (sql.includes('FROM rosters WHERE league_id')) {
              return { rows: [{ id: 1 }] };
            }
            if (sql.includes('UPDATE auction_lots SET bid_deadline')) {
              deadlineUpdateCalled = true;
              return { rows: [], rowCount: 1 };
            }
            return { rows: [], rowCount: 1 };
          }),
        };

        mockLeagueRepo.findById.mockResolvedValue(mockLeague);
        mockLotRepo.getRosterBudgetDataWithClient.mockResolvedValue({
          spent: 0,
          wonCount: 0,
          leadingCommitment: 5, // leading this lot at $5
        });

        // Price and leader unchanged: leader just raised their max bid
        mockResolvePriceWithClient.mockResolvedValue({
          updatedLot: unchangedLot,
          outbidNotifications: [],
          leaderChanged: false,
          priceChanged: false,
        });

        return fn(mockClient);
      });

      mockLotRepo.getProxyBid.mockResolvedValue({ ...mockProxyBid, maxBid: 100 });

      const result = await service.setMaxBid(1, 'user-1', 1, 100);

      // Timer should NOT be reset when only max bid is raised without price/leader change
      expect(deadlineUpdateCalled).toBe(false);
      expect(result.lot.currentBid).toBe(5); // price unchanged
    });

    it('should reject when leader tries to lower bid below current price', async () => {
      mockDraftRepo.findById.mockResolvedValue(mockFastDraft);
      mockRosterRepo.findByLeagueAndUser.mockResolvedValue(mockRoster as any);

      const { runWithLock } = require('../../../shared/transaction-runner');

      const activeLotRow = {
        id: 1,
        draft_id: 1,
        player_id: 100,
        nominator_roster_id: 1,
        current_bid: 10,
        current_bidder_roster_id: 1, // roster 1 is leading at $10
        bid_count: 2,
        bid_deadline: new Date(Date.now() + 30000),
        status: 'active',
        winning_roster_id: null,
        winning_bid: null,
        created_at: new Date(),
        updated_at: new Date(),
      };

      runWithLock.mockImplementationOnce(async (_pool: any, _domain: any, _id: any, fn: any) => {
        const mockClient = {
          query: jest.fn().mockImplementation((sql: string) => {
            if (sql.includes('FROM auction_lots WHERE id') && sql.includes('FOR UPDATE')) {
              return { rows: [activeLotRow] };
            }
            if (sql.includes('FROM rosters WHERE league_id')) {
              return { rows: [{ id: 1 }] };
            }
            return { rows: [], rowCount: 1 };
          }),
        };
        return fn(mockClient);
      });

      // Try to set maxBid to 5, but current price is 10
      await expect(service.setMaxBid(1, 'user-1', 1, 5)).rejects.toThrow(ValidationException);

      runWithLock.mockImplementationOnce(async (_pool: any, _domain: any, _id: any, fn: any) => {
        const mockClient = {
          query: jest.fn().mockImplementation((sql: string) => {
            if (sql.includes('FROM auction_lots WHERE id') && sql.includes('FOR UPDATE')) {
              return { rows: [activeLotRow] };
            }
            if (sql.includes('FROM rosters WHERE league_id')) {
              return { rows: [{ id: 1 }] };
            }
            return { rows: [], rowCount: 1 };
          }),
        };
        return fn(mockClient);
      });

      await expect(service.setMaxBid(1, 'user-1', 1, 5)).rejects.toThrow(
        'Cannot lower max bid below current bid'
      );
    });

    it('should accept first bid at minBid for no-open-bid lots (no leader to outbid)', async () => {
      mockDraftRepo.findById.mockResolvedValue(mockFastDraft);
      mockRosterRepo.findByLeagueAndUser.mockResolvedValue(mockRoster2 as any);

      const { runWithLock } = require('../../../shared/transaction-runner');

      // Lot with no current leader (auto_nominate_no_open_bid scenario)
      const noLeaderLotRow = {
        id: 1,
        draft_id: 1,
        player_id: 100,
        nominator_roster_id: 1,
        current_bid: 1, // minBid
        current_bidder_roster_id: null, // No leader
        bid_count: 0,
        bid_deadline: new Date(Date.now() + 30000),
        status: 'active',
        winning_roster_id: null,
        winning_bid: null,
        created_at: new Date(),
        updated_at: new Date(),
      };

      const updatedLot: AuctionLot = {
        id: 1,
        draftId: 1,
        playerId: 100,
        nominatorRosterId: 1,
        currentBid: 1,
        currentBidderRosterId: 2,
        bidCount: 1,
        bidDeadline: new Date(Date.now() + 15000),
        status: 'active',
        winningRosterId: null,
        winningBid: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      runWithLock.mockImplementationOnce(async (_pool: any, _domain: any, _id: any, fn: any) => {
        const mockClient = {
          query: jest.fn().mockImplementation((sql: string) => {
            if (sql.includes('FROM auction_lots WHERE id') && sql.includes('FOR UPDATE')) {
              return { rows: [noLeaderLotRow] };
            }
            if (sql.includes('FROM rosters WHERE league_id')) {
              return { rows: [{ id: 2 }] };
            }
            return { rows: [], rowCount: 1 };
          }),
        };

        mockLeagueRepo.findById.mockResolvedValue(mockLeague);
        mockLotRepo.getRosterBudgetDataWithClient.mockResolvedValue({
          spent: 0,
          wonCount: 0,
          leadingCommitment: 0,
        });

        mockResolvePriceWithClient.mockResolvedValue({
          updatedLot,
          outbidNotifications: [],
          leaderChanged: true,
          priceChanged: false,
        });

        return fn(mockClient);
      });

      mockLotRepo.getProxyBid.mockResolvedValue({ ...mockProxyBid, maxBid: 1 });
      mockRosterRepo.findByIds.mockResolvedValue([]);

      // maxBid=1 equals minBid=1, with minIncrement=1. Without fix this would throw
      // "Bid must be at least $2" because minRequired = 1 + 1 = 2
      const result = await service.setMaxBid(1, 'user-2', 1, 1);

      expect(result.lot.currentBidderRosterId).toBe(2);
      expect(result.message).toContain('$1');
    });

    it('should reject bid when draft is paused (bidDeadline null)', async () => {
      mockDraftRepo.findById.mockResolvedValue(mockFastDraft);
      mockRosterRepo.findByLeagueAndUser.mockResolvedValue(mockRoster2 as any);

      const { runWithLock } = require('../../../shared/transaction-runner');

      const pausedLotRow = {
        id: 1,
        draft_id: 1,
        player_id: 100,
        nominator_roster_id: 1,
        current_bid: 5,
        current_bidder_roster_id: 1,
        bid_count: 1,
        bid_deadline: null, // Paused
        status: 'active',
        winning_roster_id: null,
        winning_bid: null,
        created_at: new Date(),
        updated_at: new Date(),
      };

      runWithLock.mockImplementationOnce(async (_pool: any, _domain: any, _id: any, fn: any) => {
        const mockClient = {
          query: jest.fn().mockImplementation((sql: string) => {
            if (sql.includes('FROM auction_lots WHERE id') && sql.includes('FOR UPDATE')) {
              return { rows: [pausedLotRow] };
            }
            if (sql.includes('FROM rosters WHERE league_id')) {
              return { rows: [{ id: 2 }] };
            }
            return { rows: [], rowCount: 1 };
          }),
        };
        return fn(mockClient);
      });

      await expect(service.setMaxBid(1, 'user-2', 1, 50)).rejects.toThrow('paused');
    });

    it('should reject bid when lot has expired (bidDeadline in the past)', async () => {
      mockDraftRepo.findById.mockResolvedValue(mockFastDraft);
      mockRosterRepo.findByLeagueAndUser.mockResolvedValue(mockRoster as any);

      const { runWithLock } = require('../../../shared/transaction-runner');

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

      runWithLock.mockImplementationOnce(async (_pool: any, _domain: any, _id: any, fn: any) => {
        const mockClient = {
          query: jest.fn().mockImplementation((sql: string) => {
            if (sql.includes('FROM auction_lots WHERE id') && sql.includes('FOR UPDATE')) {
              return { rows: [expiredLot] };
            }
            if (sql.includes('FROM rosters WHERE league_id')) {
              return { rows: [{ id: 1 }] };
            }
            return { rows: [], rowCount: 1 };
          }),
        };
        return fn(mockClient);
      });

      await expect(service.setMaxBid(1, 'user-1', 1, 10)).rejects.toThrow(ValidationException);

      runWithLock.mockImplementationOnce(async (_pool: any, _domain: any, _id: any, fn: any) => {
        const mockClient = {
          query: jest.fn().mockImplementation((sql: string) => {
            if (sql.includes('FROM auction_lots WHERE id') && sql.includes('FOR UPDATE')) {
              return { rows: [expiredLot] };
            }
            if (sql.includes('FROM rosters WHERE league_id')) {
              return { rows: [{ id: 1 }] };
            }
            return { rows: [], rowCount: 1 };
          }),
        };
        return fn(mockClient);
      });

      await expect(service.setMaxBid(1, 'user-1', 1, 10)).rejects.toThrow('Lot has expired');
    });
  });

  describe('advanceNominator', () => {
    it('should not emit event for non-fast auction', async () => {
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

    it('should cycle through multiple nominators skipping ineligible teams', async () => {
      const { runWithLock } = require('../../../shared/transaction-runner');

      runWithLock.mockImplementationOnce(async (_pool: any, _domain: any, _id: any, fn: any) => {
        const mockClient = {
          query: jest.fn().mockImplementation((sql: string, params?: any[]) => {
            // Draft FOR UPDATE
            if (sql.includes('FROM drafts WHERE') && sql.includes('FOR UPDATE')) {
              return {
                rows: [{
                  id: 1,
                  league_id: 1,
                  status: 'in_progress',
                  settings: { auctionMode: 'fast', nominationSeconds: 60, minBid: 1 },
                  current_pick: 1,
                }],
              };
            }
            // Draft order
            if (sql.includes('FROM draft_order')) {
              return {
                rows: [
                  { roster_id: 1, draft_position: 1 },
                  { roster_id: 2, draft_position: 2 },
                  { roster_id: 3, draft_position: 3 },
                ],
              };
            }
            // League query
            if (sql.includes('FROM leagues WHERE')) {
              return {
                rows: [{
                  id: 1,
                  league_settings: { auctionBudget: 200, rosterSlots: 15 },
                }],
              };
            }
            // UPDATE drafts (setting next nominator)
            if (sql.includes('UPDATE drafts')) {
              return { rows: [], rowCount: 1 };
            }
            return { rows: [] };
          }),
        };

        // Roster 1 (next in line): full roster -> skip
        // Roster 2: can't afford -> skip
        // Roster 3: eligible -> pick this one
        mockPlayerRepo.findRandomEligiblePlayerForAuction.mockResolvedValue(mockPlayer as any);
        mockLotRepo.getAllRosterBudgetDataWithClient.mockResolvedValue(
          new Map([
            [1, { spent: 0, wonCount: 15, leadingCommitment: 0 }],   // full roster
            [2, { spent: 200, wonCount: 14, leadingCommitment: 0 }], // can't afford
            [3, { spent: 0, wonCount: 0, leadingCommitment: 0 }],    // eligible
          ])
        );
        // Fresh budget re-verification for the eligible candidate (roster 3)
        mockLotRepo.getRosterBudgetDataWithClient.mockResolvedValue({
          spent: 0,
          wonCount: 0,
          leadingCommitment: 0,
        });

        return fn(mockClient);
      });

      await service.advanceNominator(1);

      // Verify nominator changed event was published for roster 3
      expect(mockEventBus.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'auction:nominator_changed',
          payload: expect.objectContaining({
            draftId: 1,
            nominatorRosterId: 3,
          }),
        })
      );
    });

    it('should trigger auction completion when all teams are ineligible', async () => {
      const { runWithLock } = require('../../../shared/transaction-runner');

      // First call: advanceNominatorInternal finds all teams ineligible
      // Second call: completeAuctionDraft runs in its own lock
      let callCount = 0;
      runWithLock.mockImplementation(async (_pool: any, _domain: any, _id: any, fn: any) => {
        callCount++;
        if (callCount === 1) {
          // advanceNominatorInternal
          const mockClient = {
            query: jest.fn().mockImplementation((sql: string) => {
              if (sql.includes('FROM drafts WHERE') && sql.includes('FOR UPDATE')) {
                return {
                  rows: [{
                    id: 1,
                    league_id: 1,
                    status: 'in_progress',
                    settings: { auctionMode: 'fast', nominationSeconds: 60, minBid: 1 },
                    current_pick: 1,
                  }],
                };
              }
              if (sql.includes('FROM draft_order')) {
                return {
                  rows: [
                    { roster_id: 1, draft_position: 1 },
                    { roster_id: 2, draft_position: 2 },
                  ],
                };
              }
              if (sql.includes('FROM leagues WHERE')) {
                return {
                  rows: [{
                    id: 1,
                    league_settings: { auctionBudget: 200, rosterSlots: 15 },
                  }],
                };
              }
              return { rows: [] };
            }),
          };

          mockPlayerRepo.findRandomEligiblePlayerForAuction.mockResolvedValue(mockPlayer as any);
          // All teams ineligible (full rosters)
          mockLotRepo.getAllRosterBudgetDataWithClient.mockResolvedValue(
            new Map([
              [1, { spent: 0, wonCount: 15, leadingCommitment: 0 }],
              [2, { spent: 0, wonCount: 15, leadingCommitment: 0 }],
            ])
          );

          return fn(mockClient);
        } else {
          // completeAuctionDraft
          const mockClient = {
            query: jest.fn().mockResolvedValue({ rows: [], rowCount: 1 }),
          };
          return fn(mockClient);
        }
      });

      await service.advanceNominator(1);

      // Verify draft completed event was published
      expect(mockEventBus.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'draft:completed',
          payload: expect.objectContaining({
            draftId: 1,
            leagueId: 1,
          }),
        })
      );

      // Verify finalizeDraftCompletion was called
      expect(mockFinalizeDraftCompletion).toHaveBeenCalled();
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

    it('should throw NotFoundException when draft not found', async () => {
      const { runWithLock } = require('../../../shared/transaction-runner');
      runWithLock.mockImplementationOnce(async (_pool: any, _domain: any, _id: any, fn: any) => {
        const mockClient = {
          query: jest.fn().mockResolvedValueOnce({ rows: [] }),
        };
        return fn(mockClient);
      });

      // advanceNominatorInternal throws NotFoundException, forceAdvanceNominator re-throws
      await expect(service.forceAdvanceNominator(1)).rejects.toThrow(NotFoundException);
    });

    it('should behave the same as advanceNominator (shared internal logic)', async () => {
      const { runWithLock } = require('../../../shared/transaction-runner');

      runWithLock.mockImplementationOnce(async (_pool: any, _domain: any, _id: any, fn: any) => {
        const mockClient = {
          query: jest.fn().mockImplementation((sql: string) => {
            if (sql.includes('FROM drafts WHERE') && sql.includes('FOR UPDATE')) {
              return {
                rows: [{
                  id: 1,
                  league_id: 1,
                  status: 'in_progress',
                  settings: { auctionMode: 'fast', nominationSeconds: 60, minBid: 1 },
                  current_pick: 1,
                }],
              };
            }
            if (sql.includes('FROM draft_order')) {
              return {
                rows: [
                  { roster_id: 1, draft_position: 1 },
                  { roster_id: 2, draft_position: 2 },
                ],
              };
            }
            if (sql.includes('FROM leagues WHERE')) {
              return {
                rows: [{
                  id: 1,
                  league_settings: { auctionBudget: 200, rosterSlots: 15 },
                }],
              };
            }
            if (sql.includes('UPDATE drafts')) {
              return { rows: [], rowCount: 1 };
            }
            return { rows: [] };
          }),
        };

        mockPlayerRepo.findRandomEligiblePlayerForAuction.mockResolvedValue(mockPlayer as any);
        mockLotRepo.getAllRosterBudgetDataWithClient.mockResolvedValue(
          new Map([
            [1, { spent: 0, wonCount: 0, leadingCommitment: 0 }],
            [2, { spent: 0, wonCount: 0, leadingCommitment: 0 }],
          ])
        );
        // Fresh budget re-verification for the eligible candidate
        mockLotRepo.getRosterBudgetDataWithClient.mockResolvedValue({
          spent: 0,
          wonCount: 0,
          leadingCommitment: 0,
        });

        return fn(mockClient);
      });

      await service.forceAdvanceNominator(1);

      // Should emit nominator changed event, same as advanceNominator
      expect(mockEventBus.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'auction:nominator_changed',
          payload: expect.objectContaining({
            draftId: 1,
          }),
        })
      );
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
        current_roster_id: 1,
      };

      let completionQueryCalled = false;

      // autoNominate calls runWithLock once (returns skipReason: no_eligible_players),
      // then advanceNominator calls runWithLock (detects no eligible players -> completion),
      // then completeAuctionDraft calls runWithLock (marks completed)
      let callCount = 0;
      runWithLock.mockImplementation(async (_pool: any, _domain: any, _id: any, fn: any) => {
        callCount++;
        const mockClient = {
          query: jest.fn().mockImplementation((sql: string) => {
            if (sql.includes('FROM drafts WHERE') && sql.includes('FOR UPDATE')) {
              return { rows: [rawDraftRow] };
            }
            if (sql.includes("UPDATE drafts SET status = $1") && sql.includes("WHERE id = $2")) {
              completionQueryCalled = true;
              return { rows: [], rowCount: 1 };
            }
            return { rows: [], rowCount: 1 };
          }),
        };
        return fn(mockClient);
      });

      const result = await service.autoNominate(1);

      expect(result).toBeNull();
      // Verify draft was marked as completed via raw SQL (not draftRepo.update)
      expect(completionQueryCalled).toBe(true);
    });

    it('should skip and advance when nominator cannot afford min bid', async () => {
      mockDraftRepo.findById.mockResolvedValue(mockFastDraft);

      const { runWithLock } = require('../../../shared/transaction-runner');

      let callCount = 0;
      runWithLock.mockImplementation(async (_pool: any, _domain: any, _id: any, fn: any) => {
        callCount++;
        if (callCount === 1) {
          // autoNominate transaction
          const mockClient = {
            query: jest.fn().mockImplementation((sql: string) => {
              if (sql.includes('FROM drafts WHERE') && sql.includes('FOR UPDATE')) {
                return {
                  rows: [{
                    status: 'in_progress',
                    settings: { auctionMode: 'fast', nominationSeconds: 60, minBid: 1 },
                    current_roster_id: 1,
                  }],
                };
              }
              return { rows: [] };
            }),
          };

          mockLotRepo.hasActiveLotWithClient.mockResolvedValue(false);
          mockPlayerRepo.findRandomEligiblePlayerForAuction.mockResolvedValue(mockPlayer as any);
          // Nominator cannot afford: budget fully spent
          mockLotRepo.getRosterBudgetDataWithClient.mockResolvedValue({
            spent: 200,
            wonCount: 14,
            leadingCommitment: 0,
          });
          mockLeagueRepo.findById.mockResolvedValue(mockLeague);

          return fn(mockClient);
        } else {
          // advanceNominator transaction (called after skip)
          const mockClient = {
            query: jest.fn().mockImplementation((sql: string) => {
              if (sql.includes('FROM drafts WHERE') && sql.includes('FOR UPDATE')) {
                return {
                  rows: [{
                    id: 1,
                    league_id: 1,
                    status: 'in_progress',
                    settings: { auctionMode: 'fast', nominationSeconds: 60, minBid: 1 },
                    current_pick: 1,
                  }],
                };
              }
              if (sql.includes('FROM draft_order')) {
                return {
                  rows: [
                    { roster_id: 1, draft_position: 1 },
                    { roster_id: 2, draft_position: 2 },
                  ],
                };
              }
              if (sql.includes('FROM leagues WHERE')) {
                return {
                  rows: [{
                    id: 1,
                    league_settings: { auctionBudget: 200, rosterSlots: 15 },
                  }],
                };
              }
              if (sql.includes('UPDATE drafts')) {
                return { rows: [], rowCount: 1 };
              }
              return { rows: [] };
            }),
          };

          mockPlayerRepo.findRandomEligiblePlayerForAuction.mockResolvedValue(mockPlayer as any);
          mockLotRepo.getAllRosterBudgetDataWithClient.mockResolvedValue(
            new Map([
              [1, { spent: 200, wonCount: 14, leadingCommitment: 0 }],
              [2, { spent: 0, wonCount: 0, leadingCommitment: 0 }],
            ])
          );
          // Fresh budget re-verification for the eligible candidate (roster 2)
          mockLotRepo.getRosterBudgetDataWithClient.mockResolvedValue({
            spent: 0,
            wonCount: 0,
            leadingCommitment: 0,
          });

          return fn(mockClient);
        }
      });

      const result = await service.autoNominate(1);

      expect(result).toBeNull();
      // Verify advanceNominator was called (nominator changed event emitted)
      expect(mockEventBus.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'auction:nominator_changed',
        })
      );
    });

    it('should select a random eligible player and create lot', async () => {
      mockDraftRepo.findById.mockResolvedValue(mockFastDraft);

      const { runWithLock } = require('../../../shared/transaction-runner');

      const createdLot: AuctionLot = {
        ...mockLot,
        currentBidderRosterId: 1,
        currentBid: 1,
      };

      runWithLock.mockImplementationOnce(async (_pool: any, _domain: any, _id: any, fn: any) => {
        const mockClient = {
          query: jest.fn().mockImplementation((sql: string) => {
            if (sql.includes('FROM drafts WHERE') && sql.includes('FOR UPDATE')) {
              return {
                rows: [{
                  status: 'in_progress',
                  settings: { auctionMode: 'fast', nominationSeconds: 60, minBid: 1 },
                  current_roster_id: 1,
                }],
              };
            }
            return { rows: [], rowCount: 1 };
          }),
        };

        mockLotRepo.hasActiveLotWithClient.mockResolvedValue(false);
        mockPlayerRepo.findRandomEligiblePlayerForAuction.mockResolvedValue(mockPlayer as any);
        mockLotRepo.getRosterBudgetDataWithClient.mockResolvedValue({
          spent: 0,
          wonCount: 0,
          leadingCommitment: 0,
        });
        mockLeagueRepo.findById.mockResolvedValue(mockLeague);
        mockLotRepo.createLotWithClient.mockResolvedValue(createdLot);

        return fn(mockClient);
      });

      const result = await service.autoNominate(1);

      expect(result).not.toBeNull();
      expect(result!.lot).toBeDefined();
      expect(result!.lot.currentBidderRosterId).toBe(1);
      expect(result!.message).toContain('Auto-nominated');
      expect(result!.message).toContain('Test Player');

      // Verify lot creation
      expect(mockLotRepo.createLotWithClient).toHaveBeenCalled();

      // Verify event was published
      expect(mockEventBus.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'auction:lot_started',
          payload: expect.objectContaining({
            draftId: 1,
            isAutoNomination: true,
          }),
        })
      );
    });

    it('should use locked draft state (not stale preflight) for currentRosterId', async () => {
      // Preflight read returns currentRosterId: 10 (stale)
      const staleDraft = {
        ...mockFastDraft,
        currentRosterId: 10,
      };
      mockDraftRepo.findById.mockResolvedValue(staleDraft);

      const { runWithLock } = require('../../../shared/transaction-runner');

      const createdLot: AuctionLot = {
        ...mockLot,
        currentBidderRosterId: 20,
        currentBid: 1,
      };

      runWithLock.mockImplementationOnce(async (_pool: any, _domain: any, _id: any, fn: any) => {
        const mockClient = {
          query: jest.fn().mockImplementation((sql: string) => {
            // FOR UPDATE re-read returns current_roster_id: 20 (fresh)
            if (sql.includes('FROM drafts WHERE') && sql.includes('FOR UPDATE')) {
              return {
                rows: [{
                  status: 'in_progress',
                  settings: { auctionMode: 'fast', nominationSeconds: 60, minBid: 1 },
                  current_roster_id: 20,
                }],
              };
            }
            return { rows: [], rowCount: 1 };
          }),
        };

        mockLotRepo.hasActiveLotWithClient.mockResolvedValue(false);
        mockPlayerRepo.findRandomEligiblePlayerForAuction.mockResolvedValue(mockPlayer as any);
        mockLotRepo.getRosterBudgetDataWithClient.mockResolvedValue({
          spent: 0,
          wonCount: 0,
          leadingCommitment: 0,
        });
        mockLeagueRepo.findById.mockResolvedValue(mockLeague);
        mockLotRepo.createLotWithClient.mockResolvedValue(createdLot);

        return fn(mockClient);
      });

      const result = await service.autoNominate(1);

      expect(result).not.toBeNull();
      // Verify createLotWithClient was called with the locked rosterId (20), not stale (10)
      expect(mockLotRepo.createLotWithClient).toHaveBeenCalledWith(
        expect.anything(), // client
        1,                 // draftId
        100,               // playerId
        20,                // rosterId from locked state, NOT 10
        expect.any(Date),  // bidDeadline
        1,                 // minBid
        undefined,
        undefined,
        1                  // activeLeagueSeasonId
      );
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

      runWithLock.mockImplementationOnce(async (_pool: any, _domain: any, _id: any, fn: any) => {
        const mockClient = {
          query: jest.fn().mockImplementation((sql: string) => {
            if (sql.includes('FROM auction_lots WHERE id') && sql.includes('FOR UPDATE')) {
              return { rows: [expiredLot] };
            }
            if (sql.includes('FROM rosters WHERE league_id')) {
              return { rows: [{ id: 1 }] };
            }
            return { rows: [], rowCount: 1 };
          }),
        };
        return fn(mockClient);
      });

      await expect(service.setMaxBid(1, 'user-1', 1, 10)).rejects.toThrow(ValidationException);

      // Verify error message
      runWithLock.mockImplementationOnce(async (_pool: any, _domain: any, _id: any, fn: any) => {
        const mockClient = {
          query: jest.fn().mockImplementation((sql: string) => {
            if (sql.includes('FROM auction_lots WHERE id') && sql.includes('FOR UPDATE')) {
              return { rows: [expiredLot] };
            }
            if (sql.includes('FROM rosters WHERE league_id')) {
              return { rows: [{ id: 1 }] };
            }
            return { rows: [], rowCount: 1 };
          }),
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
            // Draft FOR UPDATE re-validation (TOCTOU fix)
            if (sql.includes('FROM drafts WHERE') && sql.includes('FOR UPDATE')) {
              return {
                rows: [{
                  status: 'in_progress',
                  settings: { auctionMode: 'fast', nominationSeconds: 120, maxLotDurationSeconds: 60, minBid: 1, minIncrement: 1 },
                  current_roster_id: 1,
                }],
              };
            }
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

  describe('budget edge cases', () => {
    /**
     * Helper to set up a bid test with specific budget data.
     * Configures mocks for the setMaxBid flow including draft, roster,
     * lot, league, and budget data.
     */
    function setupBidWithBudget(budgetData: {
      spent: number;
      wonCount: number;
      leadingCommitment: number;
    }, lotCurrentBid: number, isLeading: boolean) {
      mockDraftRepo.findById.mockResolvedValue(mockFastDraft);
      const bidderRoster = isLeading ? mockRoster : mockRoster2;
      mockRosterRepo.findByLeagueAndUser.mockResolvedValue(bidderRoster as any);

      const { runWithLock } = require('../../../shared/transaction-runner');

      const lotRow = {
        id: 1,
        draft_id: 1,
        player_id: 100,
        nominator_roster_id: 1,
        current_bid: lotCurrentBid,
        current_bidder_roster_id: isLeading ? bidderRoster.id : 99,
        bid_count: 1,
        bid_deadline: new Date(Date.now() + 30000),
        status: 'active',
        winning_roster_id: null,
        winning_bid: null,
        created_at: new Date(),
        updated_at: new Date(),
      };

      return { runWithLock, lotRow, bidderRoster };
    }

    it('should succeed when bid is exactly at budget limit', async () => {
      // Budget: 200, rosterSlots: 15, spent: 0, wonCount: 0, leadingCommitment: 0
      // Remaining slots after this: 15 - 0 - 1 = 14, reserved: 14 * 1 = 14
      // Max affordable: 200 - 0 - 14 - 0 = 186
      const { runWithLock, lotRow } = setupBidWithBudget(
        { spent: 0, wonCount: 0, leadingCommitment: 0 },
        5, // current bid
        false // not leading
      );

      const updatedLot: AuctionLot = {
        id: 1,
        draftId: 1,
        playerId: 100,
        nominatorRosterId: 1,
        currentBid: 186,
        currentBidderRosterId: 2,
        bidCount: 2,
        bidDeadline: new Date(Date.now() + 15000),
        status: 'active',
        winningRosterId: null,
        winningBid: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      runWithLock.mockImplementationOnce(async (_pool: any, _domain: any, _id: any, fn: any) => {
        const mockClient = {
          query: jest.fn().mockImplementation((sql: string) => {
            if (sql.includes('FROM auction_lots WHERE id') && sql.includes('FOR UPDATE')) {
              return { rows: [lotRow] };
            }
            if (sql.includes('FROM rosters WHERE league_id')) {
              return { rows: [{ id: 2 }] };
            }
            return { rows: [], rowCount: 1 };
          }),
        };

        mockLeagueRepo.findById.mockResolvedValue(mockLeague);
        mockLotRepo.getRosterBudgetDataWithClient.mockResolvedValue({
          spent: 0,
          wonCount: 0,
          leadingCommitment: 0,
        });

        mockResolvePriceWithClient.mockResolvedValue({
          updatedLot,
          outbidNotifications: [],
          leaderChanged: true,
          priceChanged: true,
        });

        return fn(mockClient);
      });

      mockLotRepo.getProxyBid.mockResolvedValue({ ...mockProxyBid, maxBid: 186 });

      // Bid exactly at max affordable (186)
      const result = await service.setMaxBid(1, 'user-2', 1, 186);
      expect(result.lot).toBeDefined();
      expect(result.message).toContain('$186');
    });

    it('should fail when bid is one dollar over budget limit', async () => {
      // Max affordable = 200 - 0 - 14*1 - 0 = 186
      // Bid 187 should fail
      const { runWithLock, lotRow } = setupBidWithBudget(
        { spent: 0, wonCount: 0, leadingCommitment: 0 },
        5,
        false
      );

      runWithLock.mockImplementationOnce(async (_pool: any, _domain: any, _id: any, fn: any) => {
        const mockClient = {
          query: jest.fn().mockImplementation((sql: string) => {
            if (sql.includes('FROM auction_lots WHERE id') && sql.includes('FOR UPDATE')) {
              return { rows: [lotRow] };
            }
            if (sql.includes('FROM rosters WHERE league_id')) {
              return { rows: [{ id: 2 }] };
            }
            return { rows: [], rowCount: 1 };
          }),
        };

        mockLeagueRepo.findById.mockResolvedValue(mockLeague);
        mockLotRepo.getRosterBudgetDataWithClient.mockResolvedValue({
          spent: 0,
          wonCount: 0,
          leadingCommitment: 0,
        });

        return fn(mockClient);
      });

      await expect(service.setMaxBid(1, 'user-2', 1, 187)).rejects.toThrow(ValidationException);

      // Verify error message mentions max affordable
      runWithLock.mockImplementationOnce(async (_pool: any, _domain: any, _id: any, fn: any) => {
        const mockClient = {
          query: jest.fn().mockImplementation((sql: string) => {
            if (sql.includes('FROM auction_lots WHERE id') && sql.includes('FOR UPDATE')) {
              return { rows: [lotRow] };
            }
            if (sql.includes('FROM rosters WHERE league_id')) {
              return { rows: [{ id: 2 }] };
            }
            return { rows: [], rowCount: 1 };
          }),
        };

        mockLeagueRepo.findById.mockResolvedValue(mockLeague);
        mockLotRepo.getRosterBudgetDataWithClient.mockResolvedValue({
          spent: 0,
          wonCount: 0,
          leadingCommitment: 0,
        });

        return fn(mockClient);
      });

      await expect(service.setMaxBid(1, 'user-2', 1, 187)).rejects.toThrow('$186');
    });

    it('should free up leading commitment when leader bids on their own lot', async () => {
      // Roster 1 is leading lot at $50 with leadingCommitment of 50
      // Budget: 200, spent: 100, wonCount: 5, leadingCommitment: 50
      // Remaining slots: 15 - 5 - 1 = 9, reserved: 9 * 1 = 9
      // Without leading lot credit: 200 - 100 - 9 - 50 = 41
      // With leading lot credit (isLeading=true): 41 + 50 = 91
      const { runWithLock, lotRow } = setupBidWithBudget(
        { spent: 100, wonCount: 5, leadingCommitment: 50 },
        50,
        true // leading
      );

      const updatedLot: AuctionLot = {
        id: 1,
        draftId: 1,
        playerId: 100,
        nominatorRosterId: 1,
        currentBid: 50,
        currentBidderRosterId: 1,
        bidCount: 1,
        bidDeadline: new Date(Date.now() + 30000),
        status: 'active',
        winningRosterId: null,
        winningBid: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      runWithLock.mockImplementationOnce(async (_pool: any, _domain: any, _id: any, fn: any) => {
        const mockClient = {
          query: jest.fn().mockImplementation((sql: string) => {
            if (sql.includes('FROM auction_lots WHERE id') && sql.includes('FOR UPDATE')) {
              return { rows: [lotRow] };
            }
            if (sql.includes('FROM rosters WHERE league_id')) {
              return { rows: [{ id: 1 }] };
            }
            return { rows: [], rowCount: 1 };
          }),
        };

        mockLeagueRepo.findById.mockResolvedValue(mockLeague);
        mockLotRepo.getRosterBudgetDataWithClient.mockResolvedValue({
          spent: 100,
          wonCount: 5,
          leadingCommitment: 50,
        });

        mockResolvePriceWithClient.mockResolvedValue({
          updatedLot,
          outbidNotifications: [],
          leaderChanged: false,
          priceChanged: false,
        });

        return fn(mockClient);
      });

      mockLotRepo.getProxyBid.mockResolvedValue({ ...mockProxyBid, maxBid: 91 });

      // Bid 91 should succeed because leading lot commitment is freed
      const result = await service.setMaxBid(1, 'user-1', 1, 91);
      expect(result.lot).toBeDefined();

      // But 92 should fail
      runWithLock.mockImplementationOnce(async (_pool: any, _domain: any, _id: any, fn: any) => {
        const mockClient = {
          query: jest.fn().mockImplementation((sql: string) => {
            if (sql.includes('FROM auction_lots WHERE id') && sql.includes('FOR UPDATE')) {
              return { rows: [lotRow] };
            }
            if (sql.includes('FROM rosters WHERE league_id')) {
              return { rows: [{ id: 1 }] };
            }
            return { rows: [], rowCount: 1 };
          }),
        };

        mockLeagueRepo.findById.mockResolvedValue(mockLeague);
        mockLotRepo.getRosterBudgetDataWithClient.mockResolvedValue({
          spent: 100,
          wonCount: 5,
          leadingCommitment: 50,
        });

        return fn(mockClient);
      });

      await expect(service.setMaxBid(1, 'user-1', 1, 92)).rejects.toThrow(ValidationException);
    });
  });

  describe('completeAuctionDraft', () => {
    it('should mark draft completed, finalize rosters, and emit event', async () => {
      const { runWithLock } = require('../../../shared/transaction-runner');

      // Set up advanceNominator to detect all teams ineligible -> trigger completion
      let callCount = 0;
      runWithLock.mockImplementation(async (_pool: any, _domain: any, _id: any, fn: any) => {
        callCount++;
        if (callCount === 1) {
          // advanceNominatorInternal: all teams have full rosters
          const mockClient = {
            query: jest.fn().mockImplementation((sql: string) => {
              if (sql.includes('FROM drafts WHERE') && sql.includes('FOR UPDATE')) {
                return {
                  rows: [{
                    id: 1,
                    league_id: 1,
                    status: 'in_progress',
                    settings: { auctionMode: 'fast', nominationSeconds: 60, minBid: 1 },
                    current_pick: 1,
                  }],
                };
              }
              if (sql.includes('FROM draft_order')) {
                return {
                  rows: [{ roster_id: 1, draft_position: 1 }],
                };
              }
              if (sql.includes('FROM leagues WHERE')) {
                return {
                  rows: [{
                    id: 1,
                    league_settings: { auctionBudget: 200, rosterSlots: 15 },
                  }],
                };
              }
              return { rows: [] };
            }),
          };

          mockPlayerRepo.findRandomEligiblePlayerForAuction.mockResolvedValue(mockPlayer as any);
          mockLotRepo.getAllRosterBudgetDataWithClient.mockResolvedValue(
            new Map([[1, { spent: 0, wonCount: 15, leadingCommitment: 0 }]])
          );

          return fn(mockClient);
        } else {
          // completeAuctionDraft: runs inside its own lock
          const mockClient = {
            query: jest.fn().mockResolvedValue({ rows: [], rowCount: 1 }),
          };
          return fn(mockClient);
        }
      });

      await service.advanceNominator(1);

      // Verify finalizeDraftCompletion was called with correct arguments
      expect(mockFinalizeDraftCompletion).toHaveBeenCalledWith(
        expect.objectContaining({
          draftRepo: mockDraftRepo,
          leagueRepo: mockLeagueRepo,
          rosterPlayersRepo: expect.anything(),
        }),
        1,  // draftId
        1,  // leagueId
        expect.anything()  // client
      );

      // Verify draft completed event was published
      expect(mockEventBus.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'draft:completed',
          payload: {
            draftId: 1,
            leagueId: 1,
          },
        })
      );
    });

    it('should emit DRAFT_COMPLETED event after completion', async () => {
      const { runWithLock } = require('../../../shared/transaction-runner');

      // Set up: no eligible players -> triggers completion directly
      let callCount = 0;
      runWithLock.mockImplementation(async (_pool: any, _domain: any, _id: any, fn: any) => {
        callCount++;
        if (callCount === 1) {
          // advanceNominatorInternal: no eligible players
          const mockClient = {
            query: jest.fn().mockImplementation((sql: string) => {
              if (sql.includes('FROM drafts WHERE') && sql.includes('FOR UPDATE')) {
                return {
                  rows: [{
                    id: 1,
                    league_id: 1,
                    status: 'in_progress',
                    settings: { auctionMode: 'fast', nominationSeconds: 60, minBid: 1 },
                    current_pick: 1,
                  }],
                };
              }
              return { rows: [] };
            }),
          };

          // No eligible players found
          mockPlayerRepo.findRandomEligiblePlayerForAuction.mockResolvedValue(null);

          return fn(mockClient);
        } else {
          // completeAuctionDraft
          const mockClient = {
            query: jest.fn().mockResolvedValue({ rows: [], rowCount: 1 }),
          };
          return fn(mockClient);
        }
      });

      await service.advanceNominator(1);

      // Find the draft:completed event specifically
      const completedEventCall = mockEventBus.publish.mock.calls.find(
        (call: any[]) => call[0].type === 'draft:completed'
      );
      expect(completedEventCall).toBeDefined();
      expect(completedEventCall[0].payload).toEqual({
        draftId: 1,
        leagueId: 1,
      });
    });
  });

  describe('retry safety', () => {
    it('should use ON CONFLICT for proxy bid INSERT in setNominatorAsOpeningBidder', async () => {
      mockDraftRepo.findById.mockResolvedValue(mockFastDraft);
      mockRosterRepo.findByLeagueAndUser.mockResolvedValue(mockRoster as any);

      const { runWithLock } = require('../../../shared/transaction-runner');

      const capturedQueries: string[] = [];
      const createdLot: AuctionLot = {
        ...mockLot,
        currentBidderRosterId: 1,
        currentBid: 1,
      };

      runWithLock.mockImplementationOnce(async (_pool: any, _domain: any, _id: any, fn: any) => {
        const mockClient = {
          query: jest.fn().mockImplementation((sql: string) => {
            capturedQueries.push(sql);
            if (sql.includes('FROM drafts WHERE') && sql.includes('FOR UPDATE')) {
              return {
                rows: [{
                  status: 'in_progress',
                  settings: { auctionMode: 'fast', nominationSeconds: 60, minBid: 1, minIncrement: 1 },
                  current_roster_id: 1,
                }],
              };
            }
            if (sql.includes('SELECT EXISTS')) {
              return { rows: [{ exists: false }] };
            }
            return { rows: [], rowCount: 1 };
          }),
        };

        mockLotRepo.hasActiveLotWithClient.mockResolvedValue(false);
        mockPlayerRepo.findByIdWithClient.mockResolvedValue(mockPlayer as any);
        mockLotRepo.findLotByDraftAndPlayerWithClient.mockResolvedValue(null);
        mockLotRepo.getRosterBudgetDataWithClient.mockResolvedValue({
          spent: 0, wonCount: 0, leadingCommitment: 0,
        });
        mockLeagueRepo.findById.mockResolvedValue(mockLeague);
        mockLotRepo.createLotWithClient.mockResolvedValue(createdLot);

        return fn(mockClient);
      });

      await service.nominate(1, 'user-1', 100);

      // Verify proxy bid INSERT uses ON CONFLICT
      const proxyBidQuery = capturedQueries.find(sql =>
        sql.includes('auction_proxy_bids') && sql.includes('INSERT')
      );
      expect(proxyBidQuery).toBeDefined();
      expect(proxyBidQuery).toContain('ON CONFLICT');
    });

    it('should use ON CONFLICT idempotency guard for bid history INSERT in setNominatorAsOpeningBidder', async () => {
      mockDraftRepo.findById.mockResolvedValue(mockFastDraft);
      mockRosterRepo.findByLeagueAndUser.mockResolvedValue(mockRoster as any);

      const { runWithLock } = require('../../../shared/transaction-runner');

      const capturedQueries: string[] = [];
      const createdLot: AuctionLot = {
        ...mockLot,
        currentBidderRosterId: 1,
        currentBid: 1,
      };

      runWithLock.mockImplementationOnce(async (_pool: any, _domain: any, _id: any, fn: any) => {
        const mockClient = {
          query: jest.fn().mockImplementation((sql: string) => {
            capturedQueries.push(sql);
            if (sql.includes('FROM drafts WHERE') && sql.includes('FOR UPDATE')) {
              return {
                rows: [{
                  status: 'in_progress',
                  settings: { auctionMode: 'fast', nominationSeconds: 60, minBid: 1, minIncrement: 1 },
                  current_roster_id: 1,
                }],
              };
            }
            if (sql.includes('SELECT EXISTS')) {
              return { rows: [{ exists: false }] };
            }
            return { rows: [], rowCount: 1 };
          }),
        };

        mockLotRepo.hasActiveLotWithClient.mockResolvedValue(false);
        mockPlayerRepo.findByIdWithClient.mockResolvedValue(mockPlayer as any);
        mockLotRepo.findLotByDraftAndPlayerWithClient.mockResolvedValue(null);
        mockLotRepo.getRosterBudgetDataWithClient.mockResolvedValue({
          spent: 0, wonCount: 0, leadingCommitment: 0,
        });
        mockLeagueRepo.findById.mockResolvedValue(mockLeague);
        mockLotRepo.createLotWithClient.mockResolvedValue(createdLot);

        return fn(mockClient);
      });

      await service.nominate(1, 'user-1', 100);

      // Verify bid history INSERT uses ON CONFLICT idempotency guard
      const bidHistoryQuery = capturedQueries.find(sql =>
        sql.includes('auction_bid_history') && sql.includes('INSERT')
      );
      expect(bidHistoryQuery).toBeDefined();
      expect(bidHistoryQuery).toContain('ON CONFLICT');
      expect(bidHistoryQuery).toContain('idempotency_key');
    });
  });

  describe('fastAuctionTimeoutAction', () => {
    it('auto_skip_nominator: skips lot creation and advances nominator', async () => {
      const skipDraft = {
        ...mockFastDraft,
        settings: {
          ...mockFastDraft.settings,
          fastAuctionTimeoutAction: 'auto_skip_nominator' as const,
        },
      };
      mockDraftRepo.findById.mockResolvedValue(skipDraft);

      const { runWithLock } = require('../../../shared/transaction-runner');

      let callCount = 0;
      runWithLock.mockImplementation(async (_pool: any, _domain: any, _id: any, fn: any) => {
        callCount++;
        if (callCount === 1) {
          // autoNominate transaction: should return timeout_skip immediately
          const mockClient = {
            query: jest.fn().mockImplementation((sql: string) => {
              if (sql.includes('FROM drafts WHERE') && sql.includes('FOR UPDATE')) {
                return {
                  rows: [{
                    status: 'in_progress',
                    settings: { auctionMode: 'fast', nominationSeconds: 60, minBid: 1, fastAuctionTimeoutAction: 'auto_skip_nominator' },
                    current_roster_id: 1,
                  }],
                };
              }
              return { rows: [] };
            }),
          };
          mockLotRepo.hasActiveLotWithClient.mockResolvedValue(false);
          return fn(mockClient);
        } else {
          // advanceNominator transaction
          const mockClient = {
            query: jest.fn().mockImplementation((sql: string) => {
              if (sql.includes('FROM drafts WHERE') && sql.includes('FOR UPDATE')) {
                return {
                  rows: [{
                    id: 1,
                    league_id: 1,
                    status: 'in_progress',
                    settings: { auctionMode: 'fast', nominationSeconds: 60, minBid: 1 },
                    current_pick: 1,
                  }],
                };
              }
              if (sql.includes('FROM draft_order')) {
                return {
                  rows: [
                    { roster_id: 1, draft_position: 1 },
                    { roster_id: 2, draft_position: 2 },
                  ],
                };
              }
              if (sql.includes('FROM leagues WHERE')) {
                return {
                  rows: [{
                    id: 1,
                    league_settings: { auctionBudget: 200, rosterSlots: 15 },
                  }],
                };
              }
              if (sql.includes('UPDATE drafts')) {
                return { rows: [], rowCount: 1 };
              }
              return { rows: [] };
            }),
          };

          mockPlayerRepo.findRandomEligiblePlayerForAuction.mockResolvedValue(mockPlayer as any);
          mockLotRepo.getAllRosterBudgetDataWithClient.mockResolvedValue(
            new Map([
              [1, { spent: 0, wonCount: 0, leadingCommitment: 0 }],
              [2, { spent: 0, wonCount: 0, leadingCommitment: 0 }],
            ])
          );
          mockLotRepo.getRosterBudgetDataWithClient.mockResolvedValue({
            spent: 0, wonCount: 0, leadingCommitment: 0,
          });

          return fn(mockClient);
        }
      });

      const result = await service.autoNominate(1);

      expect(result).toBeNull();
      // Should NOT create a lot
      expect(mockLotRepo.createLotWithClient).not.toHaveBeenCalled();
      // Should advance nominator with timeoutSkippedRosterId in event
      expect(mockEventBus.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'auction:nominator_changed',
          payload: expect.objectContaining({
            draftId: 1,
            timeoutSkippedRosterId: 1,
          }),
        })
      );
    });

    it('auto_nominate_no_open_bid: creates lot without opening bidder', async () => {
      const noOpenBidDraft = {
        ...mockFastDraft,
        settings: {
          ...mockFastDraft.settings,
          fastAuctionTimeoutAction: 'auto_nominate_no_open_bid' as const,
        },
      };
      mockDraftRepo.findById.mockResolvedValue(noOpenBidDraft);

      const { runWithLock } = require('../../../shared/transaction-runner');

      const createdLot: AuctionLot = {
        ...mockLot,
        currentBidderRosterId: null, // No opening bidder
        currentBid: 1,
      };

      const capturedQueries: string[] = [];

      runWithLock.mockImplementationOnce(async (_pool: any, _domain: any, _id: any, fn: any) => {
        const mockClient = {
          query: jest.fn().mockImplementation((sql: string) => {
            capturedQueries.push(sql);
            if (sql.includes('FROM drafts WHERE') && sql.includes('FOR UPDATE')) {
              return {
                rows: [{
                  status: 'in_progress',
                  settings: { auctionMode: 'fast', nominationSeconds: 60, minBid: 1, fastAuctionTimeoutAction: 'auto_nominate_no_open_bid' },
                  current_roster_id: 1,
                }],
              };
            }
            return { rows: [], rowCount: 1 };
          }),
        };

        mockLotRepo.hasActiveLotWithClient.mockResolvedValue(false);
        mockPlayerRepo.findRandomEligiblePlayerForAuction.mockResolvedValue(mockPlayer as any);
        mockLotRepo.getRosterBudgetDataWithClient.mockResolvedValue({
          spent: 0, wonCount: 0, leadingCommitment: 0,
        });
        mockLeagueRepo.findById.mockResolvedValue(mockLeague);
        mockLotRepo.createLotWithClient.mockResolvedValue(createdLot);

        return fn(mockClient);
      });

      const result = await service.autoNominate(1);

      expect(result).not.toBeNull();
      expect(result!.lot).toBeDefined();
      // Lot should NOT have a current bidder
      expect(result!.lot.currentBidderRosterId).toBeNull();
      // Should create a lot
      expect(mockLotRepo.createLotWithClient).toHaveBeenCalled();
      // Should NOT have proxy bid INSERT (no setNominatorAsOpeningBidder called)
      const proxyBidQuery = capturedQueries.find(sql =>
        sql.includes('auction_proxy_bids') && sql.includes('INSERT')
      );
      expect(proxyBidQuery).toBeUndefined();
      // Event should include isAutoNomination
      expect(mockEventBus.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'auction:lot_started',
          payload: expect.objectContaining({
            draftId: 1,
            isAutoNomination: true,
          }),
        })
      );
    });

    it('auto_nominate_and_open_bid (default): current behavior unchanged', async () => {
      // Default behavior - no fastAuctionTimeoutAction set
      mockDraftRepo.findById.mockResolvedValue(mockFastDraft);

      const { runWithLock } = require('../../../shared/transaction-runner');

      const createdLot: AuctionLot = {
        ...mockLot,
        currentBidderRosterId: 1,
        currentBid: 1,
      };

      const capturedQueries: string[] = [];

      runWithLock.mockImplementationOnce(async (_pool: any, _domain: any, _id: any, fn: any) => {
        const mockClient = {
          query: jest.fn().mockImplementation((sql: string) => {
            capturedQueries.push(sql);
            if (sql.includes('FROM drafts WHERE') && sql.includes('FOR UPDATE')) {
              return {
                rows: [{
                  status: 'in_progress',
                  settings: { auctionMode: 'fast', nominationSeconds: 60, minBid: 1 },
                  current_roster_id: 1,
                }],
              };
            }
            return { rows: [], rowCount: 1 };
          }),
        };

        mockLotRepo.hasActiveLotWithClient.mockResolvedValue(false);
        mockPlayerRepo.findRandomEligiblePlayerForAuction.mockResolvedValue(mockPlayer as any);
        mockLotRepo.getRosterBudgetDataWithClient.mockResolvedValue({
          spent: 0, wonCount: 0, leadingCommitment: 0,
        });
        mockLeagueRepo.findById.mockResolvedValue(mockLeague);
        mockLotRepo.createLotWithClient.mockResolvedValue(createdLot);

        return fn(mockClient);
      });

      const result = await service.autoNominate(1);

      expect(result).not.toBeNull();
      expect(result!.lot).toBeDefined();
      // Lot should have nominator as current bidder (default behavior)
      expect(result!.lot.currentBidderRosterId).toBe(1);
      // Should create a lot
      expect(mockLotRepo.createLotWithClient).toHaveBeenCalled();
      // Should have proxy bid INSERT (setNominatorAsOpeningBidder was called)
      const proxyBidQuery = capturedQueries.find(sql =>
        sql.includes('auction_proxy_bids') && sql.includes('INSERT')
      );
      expect(proxyBidQuery).toBeDefined();
      // Event should include isAutoNomination
      expect(mockEventBus.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'auction:lot_started',
          payload: expect.objectContaining({
            draftId: 1,
            isAutoNomination: true,
          }),
        })
      );
    });
  });
});
