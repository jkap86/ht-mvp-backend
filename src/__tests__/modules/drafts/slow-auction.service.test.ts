import { Pool } from 'pg';
import { SlowAuctionService } from '../../../modules/drafts/auction/slow-auction.service';
import { AuctionLotRepository } from '../../../modules/drafts/auction/auction-lot.repository';
import { DraftRepository } from '../../../modules/drafts/drafts.repository';
import { LeagueRepository, RosterRepository } from '../../../modules/leagues/leagues.repository';
import { PlayerRepository } from '../../../modules/players/players.repository';
import {
  AuctionLot,
} from '../../../modules/drafts/auction/auction.models';
import { Draft } from '../../../modules/drafts/drafts.model';
import { NotFoundException, ValidationException } from '../../../utils/exceptions';

// Mock runWithLock and runWithLocks to bypass actual database locking
jest.mock('../../../shared/transaction-runner', () => ({
  runWithLock: jest.fn(async (_pool, _domain, _id, fn) => {
    const mockClient = {
      query: jest.fn().mockResolvedValue({ rows: [] }),
      release: jest.fn(),
    };
    return fn(mockClient);
  }),
  runWithLocks: jest.fn(async (_pool, _locks, fn) => {
    const mockClient = {
      query: jest.fn().mockResolvedValue({ rows: [] }),
      release: jest.fn(),
    };
    return fn(mockClient);
  }),
  runInTransaction: jest.fn(async (_pool, fn) => {
    const mockClient = {
      query: jest.fn().mockResolvedValue({ rows: [] }),
      release: jest.fn(),
    };
    return fn(mockClient);
  }),
  LockDomain: {
    DRAFT: 700_000_000,
    ROSTER: 200_000_000,
    AUCTION: 500_000_000,
  },
}));

// Mock auction-budget-calculator functions
jest.mock('../../../modules/drafts/auction/auction-budget-calculator', () => ({
  getRosterBudgetDataWithClient: jest.fn().mockResolvedValue({
    spent: 50,
    wonCount: 5,
    leadingCommitment: 10,
  }),
}));

// Import the mocked function for test manipulation
import { getRosterBudgetDataWithClient as mockGetRosterBudgetDataWithClient } from '../../../modules/drafts/auction/auction-budget-calculator';
const mockedGetRosterBudgetDataWithClient = mockGetRosterBudgetDataWithClient as jest.MockedFunction<
  typeof mockGetRosterBudgetDataWithClient
>;

// Mock socket service
jest.mock('../../../socket/socket.service', () => ({
  tryGetSocketService: jest.fn(() => ({
    emitAuctionLotCreated: jest.fn(),
    emitAuctionLotUpdated: jest.fn(),
  })),
}));

// Mock data
const mockDraft: Draft = {
  id: 1,
  leagueId: 1,
  draftType: 'auction',
  rounds: 15,
  pickTimeSeconds: 90,
  status: 'in_progress',
  phase: 'LIVE',
  currentPick: 1,
  currentRound: 1,
  currentRosterId: null,
  pickDeadline: null,
  scheduledStart: null,
  startedAt: new Date(),
  completedAt: null,
  settings: {
    bidWindowSeconds: 43200,
    maxActiveNominationsPerTeam: 2,
    maxActiveNominationsGlobal: 25,
    dailyNominationLimit: undefined,
    minBid: 1,
    minIncrement: 1,
  },
  draftState: {},
  orderConfirmed: false,
  rosterPopulationStatus: null,
  overnightPauseEnabled: false,
  overnightPauseStart: null,
  overnightPauseEnd: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const mockLeague: any = {
  id: 1,
  name: 'Test League',
  leagueSettings: {
    auctionBudget: 200,
    rosterSlots: 15,
  },
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
  bidDeadline: new Date(Date.now() + 43200000),
  status: 'active',
  winningRosterId: null,
  winningBid: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

// Mock repositories
const createMockLotRepo = (): jest.Mocked<AuctionLotRepository> =>
  ({
    createLot: jest.fn(),
    createLotWithClient: jest.fn(),
    findLotById: jest.fn(),
    findActiveLotsByDraft: jest.fn(),
    findLotByDraftAndPlayer: jest.fn(),
    findLotByDraftAndPlayerWithClient: jest.fn(),
    countActiveLotsForRoster: jest.fn(),
    countActiveLotsForRosterWithClient: jest.fn(),
    countAllActiveLots: jest.fn(),
    countAllActiveLotsWithClient: jest.fn(),
    countDailyNominationsForRoster: jest.fn(),
    countDailyNominationsForRosterWithClient: jest.fn(),
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
    hasActiveLot: jest.fn(),
    hasActiveLotWithClient: jest.fn(),
    findLotsByDraft: jest.fn(),
    getNominatedPlayerIds: jest.fn(),
  }) as unknown as jest.Mocked<AuctionLotRepository>;

const createMockDraftRepo = (): jest.Mocked<DraftRepository> =>
  ({
    findById: jest.fn(),
    isPlayerDrafted: jest.fn(),
  }) as unknown as jest.Mocked<DraftRepository>;

const createMockLeagueRepo = (): jest.Mocked<LeagueRepository> =>
  ({
    findById: jest.fn(),
  }) as unknown as jest.Mocked<LeagueRepository>;

const createMockRosterRepo = (): jest.Mocked<RosterRepository> =>
  ({
    findByLeagueId: jest.fn(),
  }) as unknown as jest.Mocked<RosterRepository>;

const createMockPlayerRepo = (): jest.Mocked<PlayerRepository> =>
  ({
    findById: jest.fn(),
  }) as unknown as jest.Mocked<PlayerRepository>;

const createMockPool = (): jest.Mocked<Pool> =>
  ({
    connect: jest.fn(),
  }) as unknown as jest.Mocked<Pool>;

describe('SlowAuctionService', () => {
  let service: SlowAuctionService;
  let mockLotRepo: jest.Mocked<AuctionLotRepository>;
  let mockDraftRepo: jest.Mocked<DraftRepository>;
  let mockLeagueRepo: jest.Mocked<LeagueRepository>;
  let mockRosterRepo: jest.Mocked<RosterRepository>;
  let mockPlayerRepo: jest.Mocked<PlayerRepository>;
  let mockPool: jest.Mocked<Pool>;

  beforeEach(() => {
    mockLotRepo = createMockLotRepo();
    mockDraftRepo = createMockDraftRepo();
    mockLeagueRepo = createMockLeagueRepo();
    mockRosterRepo = createMockRosterRepo();
    mockPlayerRepo = createMockPlayerRepo();
    mockPool = createMockPool();

    service = new SlowAuctionService(
      mockLotRepo,
      mockDraftRepo,
      mockRosterRepo,
      mockLeagueRepo,
      mockPlayerRepo,
      mockPool
    );

    // Set up default return values for WithClient methods
    mockLotRepo.countActiveLotsForRosterWithClient.mockResolvedValue(0);
    mockLotRepo.countAllActiveLotsWithClient.mockResolvedValue(0);
    mockLotRepo.countDailyNominationsForRosterWithClient.mockResolvedValue(0);
    mockLotRepo.findLotByDraftAndPlayerWithClient.mockResolvedValue(null);
    mockLotRepo.createLotWithClient.mockResolvedValue(mockLot);

    // Set default budget data for the repo method (used inside transactions)
    mockLotRepo.getRosterBudgetDataWithClient.mockResolvedValue({
      spent: 50,
      wonCount: 5,
      leadingCommitment: 10,
    });

    // Reset the budget calculator mock to default values (legacy standalone function)
    mockedGetRosterBudgetDataWithClient.mockResolvedValue({
      spent: 50,
      wonCount: 5,
      leadingCommitment: 10,
    });
  });

  describe('getSettings', () => {
    it('should return settings from draft when present', () => {
      const settings = service.getSettings(mockDraft);

      expect(settings.bidWindowSeconds).toBe(43200);
      expect(settings.maxActiveNominationsPerTeam).toBe(2);
      expect(settings.maxActiveNominationsGlobal).toBe(25);
      expect(settings.dailyNominationLimit).toBeUndefined();
      expect(settings.minBid).toBe(1);
      expect(settings.minIncrement).toBe(1);
    });

    it('should return defaults when draft settings are missing', () => {
      const draftWithoutSettings = { ...mockDraft, settings: {} };
      const settings = service.getSettings(draftWithoutSettings);

      expect(settings.bidWindowSeconds).toBe(43200);
      expect(settings.maxActiveNominationsPerTeam).toBe(2);
      expect(settings.maxActiveNominationsGlobal).toBe(25);
      expect(settings.dailyNominationLimit).toBeUndefined();
      expect(settings.minBid).toBe(1);
      expect(settings.minIncrement).toBe(1);
    });

    it('should return custom global cap and daily limit when configured', () => {
      const draftWithLimits = {
        ...mockDraft,
        settings: {
          ...mockDraft.settings,
          maxActiveNominationsGlobal: 10,
          dailyNominationLimit: 3,
        },
      };
      const settings = service.getSettings(draftWithLimits);

      expect(settings.maxActiveNominationsGlobal).toBe(10);
      expect(settings.dailyNominationLimit).toBe(3);
    });
  });

  describe('nominate', () => {
    it('should throw NotFoundException when draft not found', async () => {
      mockDraftRepo.findById.mockResolvedValue(null);

      await expect(service.nominate(1, 1, 100)).rejects.toThrow(NotFoundException);
      await expect(service.nominate(1, 1, 100)).rejects.toThrow('Draft not found');
    });

    it('should throw ValidationException when draft is not in progress', async () => {
      mockDraftRepo.findById.mockResolvedValue({ ...mockDraft, status: 'not_started' });

      await expect(service.nominate(1, 1, 100)).rejects.toThrow(ValidationException);
      await expect(service.nominate(1, 1, 100)).rejects.toThrow('not in progress');
    });

    it('should throw ValidationException when not an auction draft', async () => {
      mockDraftRepo.findById.mockResolvedValue({ ...mockDraft, draftType: 'snake' });

      await expect(service.nominate(1, 1, 100)).rejects.toThrow(ValidationException);
      await expect(service.nominate(1, 1, 100)).rejects.toThrow('not an auction draft');
    });

    it('should throw ValidationException when player not found', async () => {
      mockDraftRepo.findById.mockResolvedValue(mockDraft);
      mockPlayerRepo.findById.mockResolvedValue(null);

      await expect(service.nominate(1, 1, 100)).rejects.toThrow(ValidationException);
      await expect(service.nominate(1, 1, 100)).rejects.toThrow('Player not found');
    });

    it('should throw ValidationException when player already drafted', async () => {
      mockDraftRepo.findById.mockResolvedValue(mockDraft);
      mockPlayerRepo.findById.mockResolvedValue(mockPlayer);
      mockDraftRepo.isPlayerDrafted.mockResolvedValue(true);

      await expect(service.nominate(1, 1, 100)).rejects.toThrow(ValidationException);
      await expect(service.nominate(1, 1, 100)).rejects.toThrow('already been drafted');
    });

    it('should throw ValidationException when roster is full', async () => {
      mockDraftRepo.findById.mockResolvedValue(mockDraft);
      mockPlayerRepo.findById.mockResolvedValue(mockPlayer);
      mockDraftRepo.isPlayerDrafted.mockResolvedValue(false);
      mockLeagueRepo.findById.mockResolvedValue(mockLeague);
      mockLotRepo.getRosterBudgetData.mockResolvedValue({
        spent: 180,
        wonCount: 15, // Full roster
        leadingCommitment: 0,
      });
      // Also mock the WithClient version used inside the transaction
      mockLotRepo.getRosterBudgetDataWithClient.mockResolvedValue({
        spent: 180,
        wonCount: 15, // Full roster
        leadingCommitment: 0,
      });

      await expect(service.nominate(1, 1, 100)).rejects.toThrow(ValidationException);
      await expect(service.nominate(1, 1, 100)).rejects.toThrow('roster is full');
    });

    it('should throw ValidationException when per-team nomination limit reached', async () => {
      mockDraftRepo.findById.mockResolvedValue(mockDraft);
      mockPlayerRepo.findById.mockResolvedValue(mockPlayer);
      mockDraftRepo.isPlayerDrafted.mockResolvedValue(false);
      mockLeagueRepo.findById.mockResolvedValue(mockLeague);
      mockLotRepo.getRosterBudgetData.mockResolvedValue({
        spent: 50,
        wonCount: 5,
        leadingCommitment: 10,
      });
      mockLotRepo.countActiveLotsForRoster.mockResolvedValue(2); // At limit (pre-check)
      mockLotRepo.countActiveLotsForRosterWithClient.mockResolvedValue(2); // At limit (in-transaction check)

      await expect(service.nominate(1, 1, 100)).rejects.toThrow(ValidationException);
      await expect(service.nominate(1, 1, 100)).rejects.toThrow('active nominations allowed');
    });

    it('should throw ValidationException when global nomination cap reached', async () => {
      const draftWithGlobalCap = {
        ...mockDraft,
        settings: {
          ...mockDraft.settings,
          maxActiveNominationsGlobal: 10,
        },
      };
      mockDraftRepo.findById.mockResolvedValue(draftWithGlobalCap);
      mockPlayerRepo.findById.mockResolvedValue(mockPlayer);
      mockDraftRepo.isPlayerDrafted.mockResolvedValue(false);
      mockLeagueRepo.findById.mockResolvedValue(mockLeague);
      mockLotRepo.getRosterBudgetData.mockResolvedValue({
        spent: 50,
        wonCount: 5,
        leadingCommitment: 10,
      });
      mockLotRepo.countActiveLotsForRoster.mockResolvedValue(1); // Under per-team limit (pre-check)
      mockLotRepo.countActiveLotsForRosterWithClient.mockResolvedValue(1); // Under per-team limit (in-transaction)
      mockLotRepo.countAllActiveLots.mockResolvedValue(10); // At global cap (pre-check)
      mockLotRepo.countAllActiveLotsWithClient.mockResolvedValue(10); // At global cap (in-transaction check)

      await expect(service.nominate(1, 1, 100)).rejects.toThrow(ValidationException);
      await expect(service.nominate(1, 1, 100)).rejects.toThrow(
        'Maximum of 10 active auctions allowed league-wide'
      );
    });

    it('should throw ValidationException when daily nomination limit reached', async () => {
      const draftWithDailyLimit = {
        ...mockDraft,
        settings: {
          ...mockDraft.settings,
          dailyNominationLimit: 2,
        },
      };
      mockDraftRepo.findById.mockResolvedValue(draftWithDailyLimit);
      mockPlayerRepo.findById.mockResolvedValue(mockPlayer);
      mockDraftRepo.isPlayerDrafted.mockResolvedValue(false);
      mockLeagueRepo.findById.mockResolvedValue(mockLeague);
      mockLotRepo.getRosterBudgetData.mockResolvedValue({
        spent: 50,
        wonCount: 5,
        leadingCommitment: 10,
      });
      mockLotRepo.countActiveLotsForRoster.mockResolvedValue(1); // Under per-team limit (pre-check)
      mockLotRepo.countActiveLotsForRosterWithClient.mockResolvedValue(1); // Under per-team limit (in-transaction)
      mockLotRepo.countAllActiveLots.mockResolvedValue(5); // Under global cap (pre-check)
      mockLotRepo.countAllActiveLotsWithClient.mockResolvedValue(5); // Under global cap (in-transaction)
      mockLotRepo.countDailyNominationsForRoster.mockResolvedValue(2); // At daily limit (pre-check)
      mockLotRepo.countDailyNominationsForRosterWithClient.mockResolvedValue(2); // At daily limit (in-transaction check)

      await expect(service.nominate(1, 1, 100)).rejects.toThrow(ValidationException);
      await expect(service.nominate(1, 1, 100)).rejects.toThrow(
        'Daily nomination limit of 2 reached'
      );
    });

    it('should allow nomination when under daily limit', async () => {
      const draftWithDailyLimit = {
        ...mockDraft,
        settings: {
          ...mockDraft.settings,
          dailyNominationLimit: 3,
        },
      };
      mockDraftRepo.findById.mockResolvedValue(draftWithDailyLimit);
      mockPlayerRepo.findById.mockResolvedValue(mockPlayer);
      mockDraftRepo.isPlayerDrafted.mockResolvedValue(false);
      mockLeagueRepo.findById.mockResolvedValue(mockLeague);
      mockLotRepo.getRosterBudgetData.mockResolvedValue({
        spent: 50,
        wonCount: 5,
        leadingCommitment: 10,
      });
      mockLotRepo.countActiveLotsForRoster.mockResolvedValue(1);
      mockLotRepo.countAllActiveLots.mockResolvedValue(5);
      mockLotRepo.countDailyNominationsForRoster.mockResolvedValue(2); // Under daily limit (2 < 3)
      mockLotRepo.countDailyNominationsForRosterWithClient.mockResolvedValue(2); // Under daily limit (2 < 3)
      mockLotRepo.findLotByDraftAndPlayer.mockResolvedValue(null);
      mockLotRepo.createLotWithClient.mockResolvedValue(mockLot);

      const result = await service.nominate(1, 1, 100);

      expect(result.lot).toEqual(mockLot);
      expect(mockLotRepo.createLotWithClient).toHaveBeenCalled();
    });

    it('should throw ValidationException when player already nominated', async () => {
      mockDraftRepo.findById.mockResolvedValue(mockDraft);
      mockPlayerRepo.findById.mockResolvedValue(mockPlayer);
      mockDraftRepo.isPlayerDrafted.mockResolvedValue(false);
      mockLeagueRepo.findById.mockResolvedValue(mockLeague);
      mockLotRepo.getRosterBudgetData.mockResolvedValue({
        spent: 50,
        wonCount: 5,
        leadingCommitment: 10,
      });
      mockLotRepo.countActiveLotsForRoster.mockResolvedValue(1);
      mockLotRepo.countAllActiveLots.mockResolvedValue(5);
      // Service uses WithClient version inside transaction
      mockLotRepo.findLotByDraftAndPlayerWithClient.mockResolvedValue(mockLot); // Already nominated

      await expect(service.nominate(1, 1, 100)).rejects.toThrow(ValidationException);
      await expect(service.nominate(1, 1, 100)).rejects.toThrow('already been nominated');
    });

    it('should create lot successfully when all validations pass', async () => {
      mockDraftRepo.findById.mockResolvedValue(mockDraft);
      mockPlayerRepo.findById.mockResolvedValue(mockPlayer);
      mockDraftRepo.isPlayerDrafted.mockResolvedValue(false);
      mockLeagueRepo.findById.mockResolvedValue(mockLeague);
      mockLotRepo.getRosterBudgetData.mockResolvedValue({
        spent: 50,
        wonCount: 5,
        leadingCommitment: 10,
      });
      mockLotRepo.countActiveLotsForRoster.mockResolvedValue(1);
      mockLotRepo.countAllActiveLots.mockResolvedValue(5);
      mockLotRepo.findLotByDraftAndPlayer.mockResolvedValue(null);
      // createLotWithClient is used within the transaction
      mockLotRepo.createLotWithClient.mockResolvedValue(mockLot);

      const result = await service.nominate(1, 1, 100);

      expect(result.lot).toEqual(mockLot);
      expect(result.message).toBe('Player nominated successfully');
      expect(mockLotRepo.createLotWithClient).toHaveBeenCalled();
    });

    it('should skip global cap check when not configured', async () => {
      const draftWithoutGlobalCap = {
        ...mockDraft,
        settings: {
          ...mockDraft.settings,
          maxActiveNominationsGlobal: undefined,
        },
      };
      mockDraftRepo.findById.mockResolvedValue(draftWithoutGlobalCap);
      mockPlayerRepo.findById.mockResolvedValue(mockPlayer);
      mockDraftRepo.isPlayerDrafted.mockResolvedValue(false);
      mockLeagueRepo.findById.mockResolvedValue(mockLeague);
      mockLotRepo.getRosterBudgetData.mockResolvedValue({
        spent: 50,
        wonCount: 5,
        leadingCommitment: 10,
      });
      mockLotRepo.countActiveLotsForRoster.mockResolvedValue(1);
      mockLotRepo.findLotByDraftAndPlayer.mockResolvedValue(null);
      // createLotWithClient is used within the transaction
      mockLotRepo.createLotWithClient.mockResolvedValue(mockLot);

      const result = await service.nominate(1, 1, 100);

      // countAllActiveLots should not be called when global cap is undefined
      // (the default is 25, so it will still be called, but nomination should succeed)
      expect(result.lot).toEqual(mockLot);
    });
  });

  describe('getNominationStats', () => {
    it('should return stats when draft exists', async () => {
      mockDraftRepo.findById.mockResolvedValue(mockDraft);
      mockLotRepo.countAllActiveLots.mockResolvedValue(10);

      const result = await service.getNominationStats(1, 1);

      expect(result.totalActiveLots).toBe(10);
      expect(result.globalActiveLimit).toBe(25);
      expect(result.globalCapReached).toBe(false);
      expect(result.dailyNominationLimit).toBeNull();
      expect(result.dailyNominationsRemaining).toBeNull();
    });

    it('should throw NotFoundException when draft not found', async () => {
      mockDraftRepo.findById.mockResolvedValue(null);

      await expect(service.getNominationStats(1, 1)).rejects.toThrow(NotFoundException);
    });

    it('should indicate global cap reached when at limit', async () => {
      const draftWithLowCap = {
        ...mockDraft,
        settings: {
          ...mockDraft.settings,
          maxActiveNominationsGlobal: 10,
        },
      };
      mockDraftRepo.findById.mockResolvedValue(draftWithLowCap);
      mockLotRepo.countAllActiveLots.mockResolvedValue(10); // At cap

      const result = await service.getNominationStats(1, 1);

      expect(result.totalActiveLots).toBe(10);
      expect(result.globalActiveLimit).toBe(10);
      expect(result.globalCapReached).toBe(true);
    });

    it('should return daily nomination stats when daily limit configured', async () => {
      const draftWithDailyLimit = {
        ...mockDraft,
        settings: {
          ...mockDraft.settings,
          dailyNominationLimit: 3,
        },
      };
      mockDraftRepo.findById.mockResolvedValue(draftWithDailyLimit);
      mockLotRepo.countAllActiveLots.mockResolvedValue(5);
      mockLotRepo.countDailyNominationsForRoster.mockResolvedValue(2);

      const result = await service.getNominationStats(1, 1);

      expect(result.dailyNominationLimit).toBe(3);
      expect(result.dailyNominationsUsed).toBe(2);
      expect(result.dailyNominationsRemaining).toBe(1);
    });

    it('should cap remaining nominations at 0 when over limit', async () => {
      const draftWithDailyLimit = {
        ...mockDraft,
        settings: {
          ...mockDraft.settings,
          dailyNominationLimit: 2,
        },
      };
      mockDraftRepo.findById.mockResolvedValue(draftWithDailyLimit);
      mockLotRepo.countAllActiveLots.mockResolvedValue(5);
      mockLotRepo.countDailyNominationsForRoster.mockResolvedValue(5); // Over limit

      const result = await service.getNominationStats(1, 1);

      expect(result.dailyNominationLimit).toBe(2);
      expect(result.dailyNominationsUsed).toBe(5);
      expect(result.dailyNominationsRemaining).toBe(0); // Capped at 0
    });
  });

  describe('getMaxAffordableBid', () => {
    it('should calculate correct affordable bid', async () => {
      mockLotRepo.getRosterBudgetData.mockResolvedValue({
        spent: 50,
        wonCount: 5,
        leadingCommitment: 20,
      });

      // totalBudget: 200, spent: 50, remainingSlots: 15-5-1=9, reserved: 9*1=9, leading: 20
      // maxAffordable = 200 - 50 - 9 - 20 = 121
      const result = await service.getMaxAffordableBid(1, 1, 200, 15);

      expect(result).toBe(121);
    });
  });

  describe('getLotById', () => {
    it('should return lot when found and belongs to draft', async () => {
      mockLotRepo.findLotById.mockResolvedValue(mockLot);

      const result = await service.getLotById(1, 1);

      expect(result).toEqual(mockLot);
    });

    it('should throw NotFoundException when lot not found', async () => {
      mockLotRepo.findLotById.mockResolvedValue(null);

      await expect(service.getLotById(1, 999)).rejects.toThrow(NotFoundException);
    });

    it('should throw NotFoundException when lot belongs to different draft', async () => {
      mockLotRepo.findLotById.mockResolvedValue({ ...mockLot, draftId: 2 });

      await expect(service.getLotById(1, 1)).rejects.toThrow(NotFoundException);
      await expect(service.getLotById(1, 1)).rejects.toThrow('not found in this draft');
    });
  });

  describe('getAllBudgets', () => {
    it('should return budgets for all rosters', async () => {
      mockDraftRepo.findById.mockResolvedValue(mockDraft);
      mockLeagueRepo.findById.mockResolvedValue(mockLeague);
      mockRosterRepo.findByLeagueId.mockResolvedValue([
        {
          id: 1,
          leagueId: 1,
          userId: 'user1',
          rosterId: 1,
          settings: {},
          starters: [],
          bench: [],
          createdAt: new Date(),
          updatedAt: new Date(),
          username: 'User1',
        } as any,
        {
          id: 2,
          leagueId: 1,
          userId: 'user2',
          rosterId: 2,
          settings: {},
          starters: [],
          bench: [],
          createdAt: new Date(),
          updatedAt: new Date(),
          username: 'User2',
        } as any,
      ]);
      mockLotRepo.getAllRosterBudgetData.mockResolvedValue(
        new Map([
          [1, { spent: 50, wonCount: 5, leadingCommitment: 20 }],
          [2, { spent: 100, wonCount: 10, leadingCommitment: 0 }],
        ])
      );

      const result = await service.getAllBudgets(1);

      expect(result).toHaveLength(2);
      expect(result[0].rosterId).toBe(1);
      expect(result[0].spent).toBe(50);
      expect(result[1].rosterId).toBe(2);
      expect(result[1].spent).toBe(100);
    });
  });
});
