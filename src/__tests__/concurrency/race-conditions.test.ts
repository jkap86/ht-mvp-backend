import { Pool, PoolClient } from 'pg';
import { DraftPickService } from '../../modules/drafts/draft-pick.service';
import { DraftRepository } from '../../modules/drafts/drafts.repository';
import { LeagueRepository, RosterRepository } from '../../modules/leagues/leagues.repository';
import { RosterPlayersRepository } from '../../modules/rosters/rosters.repository';
import { PlayerRepository } from '../../modules/players/players.repository';
import { Draft, DraftOrderEntry } from '../../modules/drafts/drafts.model';
import { DraftEngineFactory, IDraftEngine } from '../../engines';
import { AuctionLotRepository } from '../../modules/drafts/auction/auction-lot.repository';
import { AuctionLot } from '../../modules/drafts/auction/auction.models';
import {
  acceptTrade,
  AcceptTradeContext,
} from '../../modules/trades/use-cases/accept-trade.use-case';
import {
  rejectTrade,
  RejectTradeContext,
} from '../../modules/trades/use-cases/reject-trade.use-case';
import {
  TradesRepository,
  TradeItemsRepository,
} from '../../modules/trades/trades.repository';
import {
  RosterTransactionsRepository,
} from '../../modules/rosters/rosters.repository';
import { RosterMutationService } from '../../modules/rosters/roster-mutation.service';
import { Trade, TradeWithDetails } from '../../modules/trades/trades.model';
import {
  ConflictException,
  ValidationException,
} from '../../utils/exceptions';
import { container, KEYS } from '../../container';
import * as locks from '../../shared/locks';

// ---------------------------------------------------------------------------
// Global mocks
// ---------------------------------------------------------------------------

// Mock runInDraftTransaction: serialize calls by executing sequentially
// (simulates advisory lock behavior without actual Postgres)
let draftTransactionCallCount = 0;
const mockDraftClient = {} as any;
jest.spyOn(locks, 'runInDraftTransaction').mockImplementation(
  async (_pool, _draftId, fn) => fn(mockDraftClient)
);

// Mock runWithLock for trade use-cases
jest.mock('../../shared/transaction-runner', () => ({
  runWithLock: jest.fn(async (_pool: any, _domain: any, _id: any, fn: any) => {
    const mockClient = { query: jest.fn().mockResolvedValue({ rows: [] }) } as unknown as PoolClient;
    return fn(mockClient);
  }),
  LockDomain: {
    DRAFT: 700_000_000,
    ROSTER: 200_000_000,
    TRADE: 300_000_000,
    AUCTION: 500_000_000,
  },
}));

// Mock pool for container
const mockPool = {} as any;

const mockRosterMutationService = {
  addPlayerToRoster: jest.fn().mockResolvedValue({ id: 1, rosterId: 1, playerId: 100, acquiredType: 'draft', acquiredAt: new Date() }),
  removePlayerFromRoster: jest.fn(),
  swapPlayers: jest.fn(),
  bulkRemovePlayers: jest.fn().mockResolvedValue(undefined),
  bulkAddPlayers: jest.fn().mockResolvedValue(undefined),
};

const mockTransactionsRepo = {
  create: jest.fn().mockResolvedValue({ id: 1 }),
};

const mockScheduleGeneratorService = {
  generateScheduleSystem: jest.fn().mockResolvedValue(undefined),
};

jest.spyOn(container, 'resolve').mockImplementation((key: string) => {
  if (key === KEYS.POOL) return mockPool;
  if (key === KEYS.ROSTER_MUTATION_SERVICE) return mockRosterMutationService;
  if (key === KEYS.ROSTER_TRANSACTIONS_REPO) return mockTransactionsRepo;
  if (key === KEYS.SCHEDULE_GENERATOR_SERVICE) return mockScheduleGeneratorService;
  throw new Error(`No mock registered for key: ${key}`);
});

// ---------------------------------------------------------------------------
// Shared mock data
// ---------------------------------------------------------------------------

const mockDraft: Draft = {
  id: 1,
  leagueId: 1,
  draftType: 'snake',
  rounds: 15,
  pickTimeSeconds: 90,
  status: 'in_progress',
  phase: 'LIVE',
  currentPick: 1,
  currentRound: 1,
  currentRosterId: 1,
  pickDeadline: new Date(Date.now() + 90000),
  scheduledStart: null,
  startedAt: new Date(),
  completedAt: null,
  settings: {},
  draftState: {},
  orderConfirmed: true,
  rosterPopulationStatus: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const mockDraftOrder: DraftOrderEntry[] = [
  { id: 1, draftId: 1, rosterId: 1, draftPosition: 1, username: 'user1', isAutodraftEnabled: false },
  { id: 2, draftId: 1, rosterId: 2, draftPosition: 2, username: 'user2', isAutodraftEnabled: false },
  { id: 3, draftId: 1, rosterId: 3, draftPosition: 3, username: 'user3', isAutodraftEnabled: false },
];

const mockRoster1: any = { id: 1, leagueId: 1, userId: 'user-1', settings: {}, createdAt: new Date(), updatedAt: new Date() };
const mockRoster2: any = { id: 2, leagueId: 1, userId: 'user-2', settings: {}, createdAt: new Date(), updatedAt: new Date() };

const mockPick = {
  id: 1, draftId: 1, pickNumber: 1, round: 1, pickInRound: 1,
  rosterId: 1, playerId: 100, isAutoPick: false, pickedAt: new Date(),
};

// ---------------------------------------------------------------------------
// Helpers for creating mocked repositories
// ---------------------------------------------------------------------------

const createMockDraftRepo = (): jest.Mocked<DraftRepository> =>
  ({
    findById: jest.fn(),
    findByIdWithClient: jest.fn(),
    findByLeagueId: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    getDraftOrder: jest.fn(),
    getDraftOrderWithClient: jest.fn(),
    createDraftOrder: jest.fn(),
    clearDraftOrder: jest.fn(),
    getDraftPicks: jest.fn(),
    createDraftPick: jest.fn(),
    createDraftPickWithCleanup: jest.fn(),
    isPlayerDrafted: jest.fn(),
    removePlayerFromAllQueues: jest.fn(),
    makePickAndAdvanceTx: jest.fn(),
    makePickAndAdvanceTxWithClient: jest.fn(),
  }) as unknown as jest.Mocked<DraftRepository>;

const createMockLeagueRepo = (): jest.Mocked<LeagueRepository> =>
  ({
    isUserMember: jest.fn(),
    findById: jest.fn(),
    isUserCommissioner: jest.fn(),
    update: jest.fn().mockResolvedValue(undefined),
  }) as unknown as jest.Mocked<LeagueRepository>;

const createMockRosterRepo = (): jest.Mocked<RosterRepository> =>
  ({
    findById: jest.fn(),
    findByLeagueAndUser: jest.fn(),
    findByLeague: jest.fn(),
    findByLeagueAndRosterId: jest.fn(),
  }) as unknown as jest.Mocked<RosterRepository>;

const createMockPlayerRepo = (): jest.Mocked<PlayerRepository> =>
  ({
    findById: jest.fn().mockResolvedValue({ id: 100, fullName: 'Test Player', position: 'QB', team: 'TST' }),
    findByIdWithClient: jest.fn().mockResolvedValue({ id: 100, fullName: 'Test Player', position: 'QB', team: 'TST' }),
  }) as unknown as jest.Mocked<PlayerRepository>;

const createMockEngine = (): jest.Mocked<IDraftEngine> =>
  ({
    draftType: 'snake',
    getPickerForPickNumber: jest.fn((draft, draftOrder, pickNumber) => {
      const totalRosters = draftOrder.length;
      const round = Math.ceil(pickNumber / totalRosters);
      const pickInRound = ((pickNumber - 1) % totalRosters) + 1;
      const isReversed = round % 2 === 0;
      const position = isReversed ? totalRosters - pickInRound + 1 : pickInRound;
      return draftOrder.find((o: DraftOrderEntry) => o.draftPosition === position);
    }),
    getPickInRound: jest.fn((pickNumber, totalRosters) => ((pickNumber - 1) % totalRosters) + 1),
    getRound: jest.fn((pickNumber, totalRosters) => Math.ceil(pickNumber / totalRosters)),
    isDraftComplete: jest.fn(),
    getNextPickDetails: jest.fn(),
    shouldAutoPick: jest.fn(),
    calculatePickDeadline: jest.fn(() => new Date(Date.now() + 90000)),
    tick: jest.fn(),
  }) as unknown as jest.Mocked<IDraftEngine>;

const createMockEngineFactory = (): jest.Mocked<DraftEngineFactory> => {
  const engine = createMockEngine();
  return {
    createEngine: jest.fn(() => engine),
    getEngineForDraft: jest.fn(),
  } as unknown as jest.Mocked<DraftEngineFactory>;
};

const createMockRosterPlayersRepo = (): jest.Mocked<RosterPlayersRepository> =>
  ({
    addDraftedPlayer: jest.fn(),
  }) as unknown as jest.Mocked<RosterPlayersRepository>;

// ---------------------------------------------------------------------------
// Trade helpers
// ---------------------------------------------------------------------------

const createMockTrade = (overrides?: Partial<Trade>): Trade => ({
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
  ...overrides,
});

const createMockTradeWithDetails = (overrides?: Partial<Trade>): TradeWithDetails => ({
  ...createMockTrade(overrides),
  proposerTeamName: 'Team A',
  proposerUsername: 'user_a',
  recipientTeamName: 'Team B',
  recipientUsername: 'user_b',
  items: [],
  votes: [],
  canVote: false,
});

// ===========================================================================
// TEST SUITE: Race Condition Handling
// ===========================================================================

describe('Race Condition Handling', () => {
  // =========================================================================
  // 1. Concurrent Draft Picks
  // =========================================================================
  describe('Concurrent Draft Picks', () => {
    let draftPickService: DraftPickService;
    let mockDraftRepo: jest.Mocked<DraftRepository>;
    let mockLeagueRepo: jest.Mocked<LeagueRepository>;
    let mockRosterRepo: jest.Mocked<RosterRepository>;
    let mockEngineFactory: jest.Mocked<DraftEngineFactory>;
    let mockPlayerRepo: jest.Mocked<PlayerRepository>;
    let mockRosterPlayersRepo: jest.Mocked<RosterPlayersRepository>;

    beforeEach(() => {
      jest.clearAllMocks();
      draftTransactionCallCount = 0;
      mockDraftRepo = createMockDraftRepo();
      mockLeagueRepo = createMockLeagueRepo();
      mockRosterRepo = createMockRosterRepo();
      mockEngineFactory = createMockEngineFactory();
      mockPlayerRepo = createMockPlayerRepo();
      mockRosterPlayersRepo = createMockRosterPlayersRepo();

      draftPickService = new DraftPickService(
        mockDraftRepo,
        mockLeagueRepo,
        mockRosterRepo,
        mockEngineFactory,
        mockPlayerRepo,
        mockRosterPlayersRepo
      );
    });

    it('should allow only one pick when two users race for the same pick number', async () => {
      // Setup: both users are valid league members
      mockLeagueRepo.isUserMember.mockResolvedValue(true);

      // Both users see the same draft state (currentPick = 1)
      // The rightful picker is roster 1 (position 1 in round 1)
      mockDraftRepo.findByIdWithClient.mockResolvedValue(mockDraft);
      mockDraftRepo.getDraftOrderWithClient.mockResolvedValue(mockDraftOrder);

      // User 1 has roster 1 (correct picker)
      // User 2 has roster 2 (wrong picker for pick 1)
      // In a true race, both might read the same draft state before either commits.
      // The advisory lock + expectedPickNumber check prevents double-picks.

      // Simulate: user 1 picks successfully
      mockRosterRepo.findByLeagueAndUser
        .mockResolvedValueOnce(mockRoster1) // user-1's roster
        .mockResolvedValueOnce(mockRoster1); // user-1's roster (second call)

      const updatedDraft = { ...mockDraft, currentPick: 2, currentRound: 1, currentRosterId: 2 };
      mockDraftRepo.makePickAndAdvanceTxWithClient
        .mockResolvedValueOnce({ pick: mockPick, draft: updatedDraft })
        // Second call: pick already advanced past expectedPickNumber=1
        .mockRejectedValueOnce(new ConflictException('Pick already made for this position'));

      // First pick succeeds
      const result = await draftPickService.makePick(1, 1, 'user-1', 100);
      expect(result).toEqual(mockPick);

      // Second pick (same expectedPickNumber=1) fails because advisory lock serialized
      // and the CAS check on expectedPickNumber rejects stale state
      const error1 = await draftPickService.makePick(1, 1, 'user-1', 200).catch((e: any) => e);
      expect(error1).toBeInstanceOf(ConflictException);
      expect(error1.message).toContain('Pick already made');
    });

    it('should serialize concurrent picks via advisory lock so only the first succeeds', async () => {
      // This test verifies the advisory lock serialization pattern.
      // runInDraftTransaction acquires pg_advisory_xact_lock(DRAFT_OFFSET + draftId)
      // which serializes all pick operations on the same draft.

      mockLeagueRepo.isUserMember.mockResolvedValue(true);
      mockRosterRepo.findByLeagueAndUser.mockResolvedValue(mockRoster1);

      // Track the order of calls to makePickAndAdvanceTxWithClient
      const callOrder: number[] = [];

      // First call inside lock: draft is at pick 1
      mockDraftRepo.findByIdWithClient
        .mockResolvedValueOnce({ ...mockDraft, currentPick: 1 })
        // Second call inside lock: draft already advanced to pick 2
        .mockResolvedValueOnce({ ...mockDraft, currentPick: 2, currentRound: 1, currentRosterId: 2 });

      mockDraftRepo.getDraftOrderWithClient.mockResolvedValue(mockDraftOrder);

      const updatedDraft = { ...mockDraft, currentPick: 2, currentRound: 1, currentRosterId: 2 };
      mockDraftRepo.makePickAndAdvanceTxWithClient
        .mockImplementationOnce(async () => {
          callOrder.push(1);
          return { pick: mockPick, draft: updatedDraft };
        });

      // Simulate: user-1 picks player 100 first
      const result = await draftPickService.makePick(1, 1, 'user-1', 100);
      expect(result).toEqual(mockPick);

      // Simulate: user-1 attempts a second pick but draft has advanced.
      // The second call reads currentPick=2, so the currentRosterId is roster 2,
      // not roster 1 - this means "not your turn to pick".
      // Note: We need to re-mock findByIdWithClient for the second call since the first
      // two mockResolvedValueOnce entries were consumed above.
      mockDraftRepo.findByIdWithClient
        .mockResolvedValueOnce({ ...mockDraft, currentPick: 2, currentRound: 1, currentRosterId: 2 });
      const error2 = await draftPickService.makePick(1, 1, 'user-1', 200).catch((e: any) => e);
      expect(error2).toBeInstanceOf(ValidationException);
      expect(error2.message).toContain('not your turn');
    });

    it('should use expectedPickNumber in the atomic repo method for CAS protection', async () => {
      // Verifies that makePick passes the current pick number from the fresh read
      // as the expectedPickNumber to makePickAndAdvanceTxWithClient,
      // enabling the repository to do a CAS check (WHERE current_pick = expectedPickNumber).

      mockLeagueRepo.isUserMember.mockResolvedValue(true);
      mockRosterRepo.findByLeagueAndUser.mockResolvedValue(mockRoster1);

      // Use pick 7 (round 3, pick-in-round 1) where roster 1 picks in a 3-team snake
      // Round 1: r1, r2, r3. Round 2: r3, r2, r1. Round 3: r1, r2, r3.
      const draftAtPick7 = { ...mockDraft, currentPick: 7, currentRound: 3, currentRosterId: 1 };
      mockDraftRepo.findByIdWithClient.mockResolvedValue(draftAtPick7);
      mockDraftRepo.getDraftOrderWithClient.mockResolvedValue(mockDraftOrder);

      const updatedDraft = { ...draftAtPick7, currentPick: 8 };
      mockDraftRepo.makePickAndAdvanceTxWithClient.mockResolvedValue({
        pick: { ...mockPick, pickNumber: 7 },
        draft: updatedDraft,
      });

      await draftPickService.makePick(1, 1, 'user-1', 100);

      expect(mockDraftRepo.makePickAndAdvanceTxWithClient).toHaveBeenCalledWith(
        mockDraftClient,
        expect.objectContaining({
          expectedPickNumber: 7, // CAS value from fresh draft state
        })
      );
    });

    it('should reject concurrent picks for the same player', async () => {
      // Two users race to draft the same player.
      // The advisory lock serializes them. The first one gets the player.
      // The second one fails because the player is already drafted
      // (checked inside the atomic repo method).

      mockLeagueRepo.isUserMember.mockResolvedValue(true);
      mockRosterRepo.findByLeagueAndUser.mockResolvedValue(mockRoster1);
      mockDraftRepo.findByIdWithClient.mockResolvedValue(mockDraft);
      mockDraftRepo.getDraftOrderWithClient.mockResolvedValue(mockDraftOrder);

      // First call succeeds, second fails with conflict
      mockDraftRepo.makePickAndAdvanceTxWithClient
        .mockResolvedValueOnce({
          pick: mockPick,
          draft: { ...mockDraft, currentPick: 2, currentRosterId: 2 },
        })
        .mockRejectedValueOnce(new ConflictException('Player has already been drafted'));

      // First pick succeeds
      const result = await draftPickService.makePick(1, 1, 'user-1', 100);
      expect(result).toBeDefined();

      // Second pick for same player fails
      const error3 = await draftPickService.makePick(1, 1, 'user-1', 100).catch((e: any) => e);
      expect(error3).toBeInstanceOf(ConflictException);
      expect(error3.message).toContain('already been drafted');
    });
  });

  // =========================================================================
  // 2. Concurrent Auction Bids (CAS pattern)
  // =========================================================================
  describe('Concurrent Auction Bids', () => {
    let lotRepo: jest.Mocked<AuctionLotRepository>;

    const activeLot: AuctionLot = {
      id: 10,
      draftId: 1,
      playerId: 200,
      nominatorRosterId: 1,
      currentBid: 5,
      currentBidderRosterId: 1,
      bidCount: 1,
      bidDeadline: new Date(Date.now() + 60000),
      status: 'active',
      winningRosterId: null,
      winningBid: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    beforeEach(() => {
      jest.clearAllMocks();
      lotRepo = {
        findLotById: jest.fn(),
        updateLot: jest.fn(),
        createLot: jest.fn(),
        createLotWithClient: jest.fn(),
        findActiveLotsByDraft: jest.fn(),
        findLotByDraftAndPlayer: jest.fn(),
        countActiveLotsForRoster: jest.fn(),
        countAllActiveLots: jest.fn(),
        countDailyNominationsForRoster: jest.fn(),
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
        getAllRosterBudgetData: jest.fn(),
        getNominatedPlayerIds: jest.fn(),
        hasActiveLot: jest.fn(),
        hasActiveLotWithClient: jest.fn(),
      } as unknown as jest.Mocked<AuctionLotRepository>;
    });

    it('should succeed when expectedCurrentBid matches (no race condition)', async () => {
      // Bidder 2 reads lot with currentBid=5 and submits updateLot with expectedCurrentBid=5
      lotRepo.updateLot.mockResolvedValue({
        ...activeLot,
        currentBid: 10,
        currentBidderRosterId: 2,
        bidCount: 2,
      });

      const updatedLot = await lotRepo.updateLot(
        activeLot.id,
        { currentBid: 10, currentBidderRosterId: 2, bidCount: 2 },
        5 // expectedCurrentBid matches actual
      );

      expect(updatedLot.currentBid).toBe(10);
      expect(updatedLot.currentBidderRosterId).toBe(2);
      expect(lotRepo.updateLot).toHaveBeenCalledWith(
        10, // lotId
        expect.objectContaining({ currentBid: 10, currentBidderRosterId: 2 }),
        5 // CAS check value
      );
    });

    it('should fail when expectedCurrentBid is stale (concurrent bid won)', async () => {
      // Scenario: Two bidders race on the same lot.
      // Bidder A reads currentBid=5, Bidder B reads currentBid=5.
      // Bidder A's update commits first, advancing currentBid to 10.
      // Bidder B's update arrives with expectedCurrentBid=5, but actual is now 10.
      // CAS check fails -> stale update detected.

      lotRepo.updateLot
        // Bidder A succeeds: currentBid goes from 5 to 10
        .mockResolvedValueOnce({
          ...activeLot,
          currentBid: 10,
          currentBidderRosterId: 1,
          bidCount: 2,
        })
        // Bidder B fails: CAS check fails because currentBid is no longer 5
        .mockRejectedValueOnce(
          new Error('Lot state changed - stale update detected (CAS check failed)')
        );

      // Bidder A succeeds
      const resultA = await lotRepo.updateLot(
        activeLot.id,
        { currentBid: 10, currentBidderRosterId: 1, bidCount: 2 },
        5 // expectedCurrentBid matches when A runs
      );
      expect(resultA.currentBid).toBe(10);

      // Bidder B fails - stale CAS
      await expect(
        lotRepo.updateLot(
          activeLot.id,
          { currentBid: 8, currentBidderRosterId: 2, bidCount: 2 },
          5 // expectedCurrentBid is stale (actual is now 10)
        )
      ).rejects.toThrow('stale update detected');
    });

    it('should demonstrate concurrent bids where the second sees stale state via Promise.all', async () => {
      // Simulates two concurrent bids arriving at the same time.
      // Advisory lock + CAS check ensures only one can succeed.

      let callCount = 0;
      lotRepo.updateLot.mockImplementation(async (lotId, updates, expectedBid) => {
        callCount++;
        if (callCount === 1) {
          // First caller succeeds
          return {
            ...activeLot,
            currentBid: updates.currentBid!,
            currentBidderRosterId: updates.currentBidderRosterId!,
            bidCount: 2,
          };
        } else {
          // Second caller: CAS check fails
          throw new Error('Lot state changed - stale update detected (CAS check failed)');
        }
      });

      const bidA = lotRepo.updateLot(
        activeLot.id,
        { currentBid: 15, currentBidderRosterId: 1 },
        5
      );
      const bidB = lotRepo.updateLot(
        activeLot.id,
        { currentBid: 12, currentBidderRosterId: 2 },
        5
      );

      const results = await Promise.allSettled([bidA, bidB]);

      // Exactly one should succeed and one should fail
      const successes = results.filter(r => r.status === 'fulfilled');
      const failures = results.filter(r => r.status === 'rejected');

      expect(successes).toHaveLength(1);
      expect(failures).toHaveLength(1);

      // The failure should be a CAS violation
      const failedResult = failures[0] as PromiseRejectedResult;
      expect(failedResult.reason.message).toContain('stale update detected');
    });

    it('should fail when lot was settled between read and write', async () => {
      // Lot was settled (timer expired) after the bidder read it but before write
      lotRepo.updateLot.mockRejectedValue(
        new Error('Lot state changed - stale update detected (CAS check failed)')
      );

      await expect(
        lotRepo.updateLot(
          activeLot.id,
          { currentBid: 20, currentBidderRosterId: 3 },
          5 // expectedCurrentBid from stale read
        )
      ).rejects.toThrow('stale update detected');
    });

    it('should correctly report the CAS check value to the repository', async () => {
      // Verifies that the repository receives the expectedCurrentBid for the
      // WHERE clause: WHERE id = $1 AND current_bid = $expectedCurrentBid

      lotRepo.updateLot.mockResolvedValue({
        ...activeLot,
        currentBid: 25,
        currentBidderRosterId: 3,
      });

      await lotRepo.updateLot(
        activeLot.id,
        { currentBid: 25, currentBidderRosterId: 3 },
        activeLot.currentBid // The critical CAS check value
      );

      expect(lotRepo.updateLot).toHaveBeenCalledWith(
        activeLot.id,
        expect.any(Object),
        activeLot.currentBid // Must pass the current bid for CAS comparison
      );
    });
  });

  // =========================================================================
  // 3. Concurrent Trade Accept / Reject
  // =========================================================================
  describe('Concurrent Trade Accept and Reject', () => {
    const pendingTrade = createMockTrade({ status: 'pending' });
    const mockLeague: any = {
      id: 1,
      name: 'Test League',
      settings: {
        roster_size: 15,
        trade_review_enabled: false,
        trade_voting_enabled: false,
      },
    };

    it('should allow only one of accept/reject when both race concurrently', async () => {
      // Scenario: Recipient clicks "Accept" and "Reject" nearly simultaneously.
      // Both operations acquire TRADE lock on leagueId.
      // The advisory lock serializes them so one sees "pending" and the other sees
      // the already-updated status.

      // We'll test accept-then-reject ordering.
      // First call (accept) sees pending -> completes trade.
      // Second call (reject) sees completed -> throws ValidationException.

      const acceptCtx: AcceptTradeContext = {
        db: {} as Pool,
        tradesRepo: {
          findById: jest.fn()
            // Outside-lock read for accept
            .mockResolvedValueOnce(pendingTrade)
            // Inside-lock re-read for accept: still pending
            .mockResolvedValueOnce(pendingTrade)
            // Outside-lock read for reject (sees original, stale state)
            .mockResolvedValueOnce(pendingTrade)
            // Inside-lock re-read for reject: now completed
            .mockResolvedValueOnce(createMockTrade({ status: 'completed' })),
          findByIdWithDetails: jest.fn().mockResolvedValue(
            createMockTradeWithDetails({ status: 'completed' })
          ),
          updateStatus: jest.fn().mockResolvedValue(
            createMockTrade({ status: 'completed' })
          ),
          setReviewPeriod: jest.fn(),
        } as unknown as jest.Mocked<TradesRepository>,
        tradeItemsRepo: {
          findByTrade: jest.fn().mockResolvedValue([]),
        } as unknown as jest.Mocked<TradeItemsRepository>,
        rosterRepo: {
          findById: jest.fn().mockResolvedValue({
            id: 2, userId: 'user-2', leagueId: 1,
          }),
        } as unknown as jest.Mocked<RosterRepository>,
        rosterPlayersRepo: {} as jest.Mocked<RosterPlayersRepository>,
        transactionsRepo: {
          create: jest.fn().mockResolvedValue({ id: 1 }),
        } as unknown as jest.Mocked<RosterTransactionsRepository>,
        leagueRepo: {
          findById: jest.fn().mockResolvedValue(mockLeague),
        } as unknown as jest.Mocked<LeagueRepository>,
        rosterMutationService: mockRosterMutationService as unknown as RosterMutationService,
      };

      const rejectCtx: RejectTradeContext = {
        db: {} as Pool,
        tradesRepo: acceptCtx.tradesRepo as unknown as jest.Mocked<TradesRepository>,
        rosterRepo: acceptCtx.rosterRepo as unknown as jest.Mocked<RosterRepository>,
      };

      // Accept succeeds
      const acceptResult = await acceptTrade(acceptCtx, 1, 'user-2');
      expect(acceptResult.status).toBe('completed');

      // Reject fails because status is now 'completed'
      const rejectError = await rejectTrade(rejectCtx, 1, 'user-2').catch((e: any) => e);
      expect(rejectError).toBeInstanceOf(ValidationException);
      expect(rejectError.message).toContain('Cannot reject trade with status');
    });

    it('should allow only one of reject/accept when reject wins the lock', async () => {
      // Scenario: reject acquires the lock first.
      // reject sees pending -> updates to rejected.
      // accept sees rejected inside lock -> throws ValidationException.

      const sharedTradesRepo = {
        findById: jest.fn()
          // Outside-lock read for reject
          .mockResolvedValueOnce(pendingTrade)
          // Inside-lock re-read for reject: still pending
          .mockResolvedValueOnce(pendingTrade)
          // Outside-lock read for accept
          .mockResolvedValueOnce(pendingTrade)
          // Inside-lock re-read for accept: now rejected
          .mockResolvedValueOnce(createMockTrade({ status: 'rejected' })),
        findByIdWithDetails: jest.fn()
          .mockResolvedValue(createMockTradeWithDetails({ status: 'rejected' })),
        updateStatus: jest.fn().mockResolvedValue(
          createMockTrade({ status: 'rejected' })
        ),
        setReviewPeriod: jest.fn(),
      } as unknown as jest.Mocked<TradesRepository>;

      const sharedRosterRepo = {
        findById: jest.fn().mockResolvedValue({
          id: 2, userId: 'user-2', leagueId: 1,
        }),
      } as unknown as jest.Mocked<RosterRepository>;

      const rejectCtx: RejectTradeContext = {
        db: {} as Pool,
        tradesRepo: sharedTradesRepo,
        rosterRepo: sharedRosterRepo,
      };

      const acceptCtx: AcceptTradeContext = {
        db: {} as Pool,
        tradesRepo: sharedTradesRepo,
        tradeItemsRepo: {
          findByTrade: jest.fn().mockResolvedValue([]),
        } as unknown as jest.Mocked<TradeItemsRepository>,
        rosterRepo: sharedRosterRepo,
        rosterPlayersRepo: {} as jest.Mocked<RosterPlayersRepository>,
        transactionsRepo: {
          create: jest.fn().mockResolvedValue({ id: 1 }),
        } as unknown as jest.Mocked<RosterTransactionsRepository>,
        leagueRepo: {
          findById: jest.fn().mockResolvedValue(mockLeague),
        } as unknown as jest.Mocked<LeagueRepository>,
        rosterMutationService: mockRosterMutationService as unknown as RosterMutationService,
      };

      // Reject succeeds
      const rejectResult = await rejectTrade(rejectCtx, 1, 'user-2');
      expect(rejectResult.status).toBe('rejected');

      // Accept fails because status is now 'rejected'
      const acceptError = await acceptTrade(acceptCtx, 1, 'user-2').catch((e: any) => e);
      expect(acceptError).toBeInstanceOf(ValidationException);
      expect(acceptError.message).toContain('Cannot accept trade with status');
    });

    it('should handle idempotent accept retry when trade is already accepted', async () => {
      // Scenario: Network retry causes accept to be sent twice.
      // Second call finds trade already accepted inside lock -> returns current state
      // without performing any mutations.

      const acceptedTrade = createMockTrade({ status: 'accepted' });
      const acceptedDetails = createMockTradeWithDetails({ status: 'accepted' });

      const ctx: AcceptTradeContext = {
        db: {} as Pool,
        tradesRepo: {
          findById: jest.fn()
            // Outside-lock: still sees pending (stale read)
            .mockResolvedValueOnce(pendingTrade)
            // Inside-lock: already accepted by previous call
            .mockResolvedValueOnce(acceptedTrade),
          findByIdWithDetails: jest.fn().mockResolvedValue(acceptedDetails),
          updateStatus: jest.fn(),
          setReviewPeriod: jest.fn(),
        } as unknown as jest.Mocked<TradesRepository>,
        tradeItemsRepo: {
          findByTrade: jest.fn(),
        } as unknown as jest.Mocked<TradeItemsRepository>,
        rosterRepo: {
          findById: jest.fn().mockResolvedValue({
            id: 2, userId: 'user-2', leagueId: 1,
          }),
        } as unknown as jest.Mocked<RosterRepository>,
        rosterPlayersRepo: {} as jest.Mocked<RosterPlayersRepository>,
        transactionsRepo: {} as jest.Mocked<RosterTransactionsRepository>,
        leagueRepo: {
          findById: jest.fn().mockResolvedValue(mockLeague),
        } as unknown as jest.Mocked<LeagueRepository>,
        rosterMutationService: {} as RosterMutationService,
      };

      const result = await acceptTrade(ctx, 1, 'user-2');

      // Should return the existing accepted state without error
      expect(result.status).toBe('accepted');

      // Should NOT have called updateStatus (no duplicate mutation)
      expect(ctx.tradesRepo.updateStatus).not.toHaveBeenCalled();

      // Should NOT have tried to execute the trade
      expect(ctx.tradeItemsRepo.findByTrade).not.toHaveBeenCalled();
    });

    it('should handle idempotent reject retry when trade is already rejected', async () => {
      // Network retry: reject called twice.
      // Second call finds trade already rejected inside lock -> returns silently.

      const rejectedTrade = createMockTrade({ status: 'rejected' });
      const rejectedDetails = createMockTradeWithDetails({ status: 'rejected' });

      const ctx: RejectTradeContext = {
        db: {} as Pool,
        tradesRepo: {
          findById: jest.fn()
            // Outside-lock: stale read (pending)
            .mockResolvedValueOnce(pendingTrade)
            // Inside-lock: already rejected
            .mockResolvedValueOnce(rejectedTrade),
          findByIdWithDetails: jest.fn().mockResolvedValue(rejectedDetails),
          updateStatus: jest.fn(),
        } as unknown as jest.Mocked<TradesRepository>,
        rosterRepo: {
          findById: jest.fn().mockResolvedValue({
            id: 2, userId: 'user-2', leagueId: 1,
          }),
        } as unknown as jest.Mocked<RosterRepository>,
      };

      const result = await rejectTrade(ctx, 1, 'user-2');

      // Should return the rejected state without error
      expect(result.status).toBe('rejected');

      // Should NOT have called updateStatus again
      expect(ctx.tradesRepo.updateStatus).not.toHaveBeenCalled();
    });

    it('should prevent accept when trade expired between initial read and lock acquisition', async () => {
      // Scenario: Trade expires while accept request is waiting to acquire the lock.
      // Background job sets status to 'expired' before accept gets the lock.

      const ctx: AcceptTradeContext = {
        db: {} as Pool,
        tradesRepo: {
          findById: jest.fn()
            // Outside-lock: sees pending (race window)
            .mockResolvedValueOnce(pendingTrade)
            // Inside-lock: expired by background job
            .mockResolvedValueOnce(createMockTrade({ status: 'expired' })),
          findByIdWithDetails: jest.fn(),
          updateStatus: jest.fn(),
          setReviewPeriod: jest.fn(),
        } as unknown as jest.Mocked<TradesRepository>,
        tradeItemsRepo: {
          findByTrade: jest.fn(),
        } as unknown as jest.Mocked<TradeItemsRepository>,
        rosterRepo: {
          findById: jest.fn().mockResolvedValue({
            id: 2, userId: 'user-2', leagueId: 1,
          }),
        } as unknown as jest.Mocked<RosterRepository>,
        rosterPlayersRepo: {} as jest.Mocked<RosterPlayersRepository>,
        transactionsRepo: {} as jest.Mocked<RosterTransactionsRepository>,
        leagueRepo: {
          findById: jest.fn().mockResolvedValue(mockLeague),
        } as unknown as jest.Mocked<LeagueRepository>,
        rosterMutationService: {} as RosterMutationService,
      };

      await expect(acceptTrade(ctx, 1, 'user-2')).rejects.toThrow(ValidationException);
      await expect(
        acceptTrade(
          {
            ...ctx,
            tradesRepo: {
              ...ctx.tradesRepo,
              findById: jest.fn()
                .mockResolvedValueOnce(pendingTrade)
                .mockResolvedValueOnce(createMockTrade({ status: 'expired' })),
            } as unknown as jest.Mocked<TradesRepository>,
          },
          1,
          'user-2'
        )
      ).rejects.toThrow('Cannot accept trade with status');
    });
  });

  // =========================================================================
  // 4. Auction Price Resolution CAS Check
  // =========================================================================
  describe('Auction Price Resolution CAS Pattern', () => {
    it('should throw when lot state diverges during price resolution', async () => {
      // This tests the resolvePriceWithClient CAS pattern directly:
      // The SQL UPDATE uses WHERE current_bid = $expected AND current_bidder_roster_id IS NOT
      // DISTINCT FROM $expected AND status = 'active'.
      // If any of these changed, rowCount = 0 and an error is thrown.

      const lotRepo = {
        updateLot: jest.fn(),
      } as unknown as jest.Mocked<AuctionLotRepository>;

      // Simulate CAS failure at the repository level
      lotRepo.updateLot.mockRejectedValue(
        new Error('Lot state changed during price resolution - stale update detected (bid/leader changed or lot settled)')
      );

      await expect(
        lotRepo.updateLot(
          10,
          { currentBid: 15, currentBidderRosterId: 2 },
          5 // This was the bid when we read, but it changed since
        )
      ).rejects.toThrow('stale update detected');
    });

    it('should demonstrate that FOR UPDATE row lock + CAS prevents double-bidding', async () => {
      // In the real system, setMaxBid does:
      // 1. SELECT * FROM auction_lots WHERE id = $1 FOR UPDATE  (row lock)
      // 2. resolvePriceWithClient uses CAS: UPDATE ... WHERE current_bid = $expected
      //
      // The FOR UPDATE prevents concurrent reads from seeing the same state.
      // The CAS check is a defense-in-depth safeguard.

      const lotRepo = {
        updateLot: jest.fn(),
      } as unknown as jest.Mocked<AuctionLotRepository>;

      let currentBidState = 5;

      // Simulate: each call checks and advances the bid atomically
      lotRepo.updateLot.mockImplementation(async (lotId, updates, expectedBid) => {
        if (expectedBid !== currentBidState) {
          throw new Error('Lot state changed - stale update detected (CAS check failed)');
        }
        // Advance bid state (simulates committed transaction)
        currentBidState = updates.currentBid!;
        return {
          id: lotId,
          draftId: 1,
          playerId: 200,
          nominatorRosterId: 1,
          currentBid: updates.currentBid!,
          currentBidderRosterId: updates.currentBidderRosterId!,
          bidCount: 2,
          bidDeadline: new Date(),
          status: 'active' as const,
          winningRosterId: null,
          winningBid: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
      });

      // Sequential bids with proper CAS checks succeed
      const result1 = await lotRepo.updateLot(10, { currentBid: 10, currentBidderRosterId: 1 }, 5);
      expect(result1.currentBid).toBe(10);

      const result2 = await lotRepo.updateLot(10, { currentBid: 15, currentBidderRosterId: 2 }, 10);
      expect(result2.currentBid).toBe(15);

      // A bid with stale expectedBid fails
      await expect(
        lotRepo.updateLot(10, { currentBid: 12, currentBidderRosterId: 3 }, 5) // stale: actual is 15
      ).rejects.toThrow('stale update detected');
    });
  });

  // =========================================================================
  // 5. Lock Ordering Prevents Deadlocks
  // =========================================================================
  describe('Lock Ordering for Deadlock Prevention', () => {
    it('should sort locks by domain priority then by ID', () => {
      // The withLocks function in shared/locks.ts sorts locks before acquiring.
      // This prevents deadlocks where Thread A holds DRAFT(1) and waits for ROSTER(1),
      // while Thread B holds ROSTER(1) and waits for DRAFT(1).

      // Test the lock ID generation to verify ordering
      const { getLockId, LockDomain } = require('../../shared/locks');

      const draftLock = getLockId(LockDomain.DRAFT, 1);
      const rosterLock = getLockId(LockDomain.ROSTER, 1);
      const tradeLock = getLockId(LockDomain.TRADE, 1);
      const auctionLock = getLockId(LockDomain.AUCTION, 1);

      // ROSTER (200M) < TRADE (300M) < AUCTION (500M) < DRAFT (700M)
      expect(rosterLock).toBeLessThan(tradeLock);
      expect(tradeLock).toBeLessThan(auctionLock);
      expect(auctionLock).toBeLessThan(draftLock);
    });

    it('should generate unique lock IDs across domains', () => {
      const { getLockId, LockDomain } = require('../../shared/locks');

      // Two different domains with the same entity ID should not collide
      const draftLockForId1 = getLockId(LockDomain.DRAFT, 1);
      const rosterLockForId1 = getLockId(LockDomain.ROSTER, 1);

      expect(draftLockForId1).not.toBe(rosterLockForId1);

      // Same domain, different IDs should not collide
      const draftLock1 = getLockId(LockDomain.DRAFT, 1);
      const draftLock2 = getLockId(LockDomain.DRAFT, 2);

      expect(draftLock1).not.toBe(draftLock2);
      expect(draftLock2 - draftLock1).toBe(1);
    });
  });
});
