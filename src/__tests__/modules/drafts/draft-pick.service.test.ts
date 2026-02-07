import { DraftPickService } from '../../../modules/drafts/draft-pick.service';
import { DraftRepository } from '../../../modules/drafts/drafts.repository';
import { LeagueRepository, RosterRepository } from '../../../modules/leagues/leagues.repository';
import { RosterPlayersRepository, RosterTransactionsRepository } from '../../../modules/rosters/rosters.repository';
import { PlayerRepository } from '../../../modules/players/players.repository';
import { Draft, DraftOrderEntry } from '../../../modules/drafts/drafts.model';
import { DraftEngineFactory, IDraftEngine } from '../../../engines';
import {
  NotFoundException,
  ForbiddenException,
  ValidationException,
  ConflictException,
} from '../../../utils/exceptions';
import { container, KEYS } from '../../../container';
import * as locks from '../../../shared/locks';

// Mock runInDraftTransaction to bypass actual DB transactions in tests
const mockClient = {} as any;
jest.spyOn(locks, 'runInDraftTransaction').mockImplementation(
  async (_pool, _draftId, fn) => fn(mockClient)
);

// Mock pool for container
const mockPool = {} as any;

// Mock container.resolve for services used by draft completion
const mockRosterMutationService = {
  addPlayerToRoster: jest.fn().mockResolvedValue({ id: 1, rosterId: 1, playerId: 100, acquiredType: 'draft', acquiredAt: new Date() }),
  removePlayerFromRoster: jest.fn(),
  swapPlayers: jest.fn(),
  bulkRemovePlayers: jest.fn(),
  bulkAddPlayers: jest.fn(),
};

const mockTransactionsRepo = {
  create: jest.fn().mockResolvedValue({ id: 1 }),
};

const mockScheduleGeneratorService = {
  generateScheduleSystem: jest.fn().mockResolvedValue(undefined),
};

jest.spyOn(container, 'resolve').mockImplementation((key: string) => {
  if (key === KEYS.POOL) {
    return mockPool;
  }
  if (key === KEYS.ROSTER_MUTATION_SERVICE) {
    return mockRosterMutationService;
  }
  if (key === KEYS.ROSTER_TRANSACTIONS_REPO) {
    return mockTransactionsRepo;
  }
  if (key === KEYS.SCHEDULE_GENERATOR_SERVICE) {
    return mockScheduleGeneratorService;
  }
  throw new Error(`No mock registered for key: ${key}`);
});

// Mock draft data
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
  createdAt: new Date(),
  updatedAt: new Date(),
};

const mockDraftOrder: DraftOrderEntry[] = [
  {
    id: 1,
    draftId: 1,
    rosterId: 1,
    draftPosition: 1,
    username: 'user1',
    isAutodraftEnabled: false,
  },
  {
    id: 2,
    draftId: 1,
    rosterId: 2,
    draftPosition: 2,
    username: 'user2',
    isAutodraftEnabled: false,
  },
  {
    id: 3,
    draftId: 1,
    rosterId: 3,
    draftPosition: 3,
    username: 'user3',
    isAutodraftEnabled: false,
  },
];

// Use 'any' for mockRoster to avoid strict typing issues with the Roster interface
const mockRoster: any = {
  id: 1,
  leagueId: 1,
  userId: 'user-123',
  rosterId: 1,
  settings: {},
  starters: [],
  bench: [],
  createdAt: new Date(),
  updatedAt: new Date(),
};

const mockPick = {
  id: 1,
  draftId: 1,
  pickNumber: 1,
  round: 1,
  pickInRound: 1,
  rosterId: 1,
  playerId: 100,
  isAutoPick: false,
  pickedAt: new Date(),
};

// Mock repositories
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
    findByLeagueAndUser: jest.fn(),
    findByLeague: jest.fn(),
  }) as unknown as jest.Mocked<RosterRepository>;

const createMockPlayerRepo = (): jest.Mocked<PlayerRepository> =>
  ({
    findById: jest.fn().mockResolvedValue({
      id: 100,
      fullName: 'Test Player',
      position: 'QB',
      team: 'TST',
    }),
  }) as unknown as jest.Mocked<PlayerRepository>;

const createMockEngine = (): jest.Mocked<IDraftEngine> =>
  ({
    draftType: 'snake',
    getPickerForPickNumber: jest.fn((draft, draftOrder, pickNumber) => {
      const totalRosters = draftOrder.length;
      const round = Math.ceil(pickNumber / totalRosters);
      const pickInRound = ((pickNumber - 1) % totalRosters) + 1;
      // Snake logic: reverse even rounds
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
  const mockEngine = createMockEngine();
  return {
    createEngine: jest.fn(() => mockEngine),
    getEngineForDraft: jest.fn(),
  } as unknown as jest.Mocked<DraftEngineFactory>;
};

const createMockRosterPlayersRepo = (): jest.Mocked<RosterPlayersRepository> =>
  ({
    addDraftedPlayer: jest.fn(),
  }) as unknown as jest.Mocked<RosterPlayersRepository>;

describe('DraftPickService', () => {
  let draftPickService: DraftPickService;
  let mockDraftRepo: jest.Mocked<DraftRepository>;
  let mockLeagueRepo: jest.Mocked<LeagueRepository>;
  let mockRosterRepo: jest.Mocked<RosterRepository>;
  let mockEngineFactory: jest.Mocked<DraftEngineFactory>;
  let mockPlayerRepo: jest.Mocked<PlayerRepository>;
  let mockRosterPlayersRepo: jest.Mocked<RosterPlayersRepository>;

  beforeEach(() => {
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

    // Reset mocks for container-resolved services
    mockRosterMutationService.addPlayerToRoster.mockClear();
    mockRosterMutationService.addPlayerToRoster.mockResolvedValue({ id: 1, rosterId: 1, playerId: 100, acquiredType: 'draft', acquiredAt: new Date() });
    mockTransactionsRepo.create.mockClear();
    mockTransactionsRepo.create.mockResolvedValue({ id: 1 });
  });

  describe('getDraftPicks', () => {
    it('should return draft picks when user is member', async () => {
      mockLeagueRepo.isUserMember.mockResolvedValue(true);
      mockDraftRepo.findById.mockResolvedValue(mockDraft);
      mockDraftRepo.getDraftPicks.mockResolvedValue([mockPick]);

      const result = await draftPickService.getDraftPicks(1, 1, 'user-123');

      // Service transforms to snake_case for API response
      expect(result).toEqual([{
        id: mockPick.id,
        draft_id: mockPick.draftId,
        pick_number: mockPick.pickNumber,
        round: mockPick.round,
        pick_in_round: mockPick.pickInRound,
        roster_id: mockPick.rosterId,
        player_id: mockPick.playerId,
        is_auto_pick: mockPick.isAutoPick,
        picked_at: mockPick.pickedAt,
        player_name: undefined,
        player_position: undefined,
        player_team: undefined,
        username: undefined,
      }]);
      expect(mockLeagueRepo.isUserMember).toHaveBeenCalledWith(1, 'user-123');
    });

    it('should throw ForbiddenException when user is not a member', async () => {
      mockLeagueRepo.isUserMember.mockResolvedValue(false);

      await expect(draftPickService.getDraftPicks(1, 1, 'user-123')).rejects.toThrow(
        ForbiddenException
      );
      await expect(draftPickService.getDraftPicks(1, 1, 'user-123')).rejects.toThrow(
        'not a member'
      );
    });
  });

  describe('makePick', () => {
    it('should create pick and advance to next on success using atomic transaction', async () => {
      mockLeagueRepo.isUserMember.mockResolvedValue(true);
      mockDraftRepo.findByIdWithClient.mockResolvedValue(mockDraft);
      mockRosterRepo.findByLeagueAndUser.mockResolvedValue(mockRoster);
      mockDraftRepo.getDraftOrderWithClient.mockResolvedValue(mockDraftOrder);
      const updatedDraft = { ...mockDraft, currentPick: 2, currentRound: 1, currentRosterId: 2 };
      mockDraftRepo.makePickAndAdvanceTxWithClient.mockResolvedValue({ pick: mockPick, draft: updatedDraft });

      const result = await draftPickService.makePick(1, 1, 'user-123', 100);

      expect(result).toEqual(mockPick);
      // Verify atomic method was called with correct parameters
      expect(mockDraftRepo.makePickAndAdvanceTxWithClient).toHaveBeenCalledWith(
        mockClient,
        expect.objectContaining({
          draftId: 1,
          expectedPickNumber: 1,
          round: 1,
          pickInRound: 1,
          rosterId: 1,
          playerId: 100,
        })
      );
    });

    it('should throw ForbiddenException when user not a league member', async () => {
      mockLeagueRepo.isUserMember.mockResolvedValue(false);

      await expect(draftPickService.makePick(1, 1, 'user-123', 100)).rejects.toThrow(
        ForbiddenException
      );
      await expect(draftPickService.makePick(1, 1, 'user-123', 100)).rejects.toThrow(
        'not a member'
      );
    });

    it('should throw NotFoundException when draft not found', async () => {
      mockLeagueRepo.isUserMember.mockResolvedValue(true);
      mockRosterRepo.findByLeagueAndUser.mockResolvedValue(mockRoster);
      mockDraftRepo.findByIdWithClient.mockResolvedValue(null);

      await expect(draftPickService.makePick(1, 999, 'user-123', 100)).rejects.toThrow(
        NotFoundException
      );
      await expect(draftPickService.makePick(1, 999, 'user-123', 100)).rejects.toThrow(
        'Draft not found'
      );
    });

    it('should throw NotFoundException when draft not in league', async () => {
      mockLeagueRepo.isUserMember.mockResolvedValue(true);
      mockRosterRepo.findByLeagueAndUser.mockResolvedValue(mockRoster);
      mockDraftRepo.findByIdWithClient.mockResolvedValue({ ...mockDraft, leagueId: 999 });

      await expect(draftPickService.makePick(1, 1, 'user-123', 100)).rejects.toThrow(
        NotFoundException
      );
      await expect(draftPickService.makePick(1, 1, 'user-123', 100)).rejects.toThrow(
        'not found in this league'
      );
    });

    it('should throw ValidationException when draft is not in progress', async () => {
      mockLeagueRepo.isUserMember.mockResolvedValue(true);
      mockRosterRepo.findByLeagueAndUser.mockResolvedValue(mockRoster);
      mockDraftRepo.findByIdWithClient.mockResolvedValue({ ...mockDraft, status: 'not_started' });

      await expect(draftPickService.makePick(1, 1, 'user-123', 100)).rejects.toThrow(
        ValidationException
      );
      await expect(draftPickService.makePick(1, 1, 'user-123', 100)).rejects.toThrow(
        'not in progress'
      );
    });

    it('should throw ForbiddenException when user not in league roster', async () => {
      mockLeagueRepo.isUserMember.mockResolvedValue(true);
      mockDraftRepo.findById.mockResolvedValue(mockDraft);
      mockRosterRepo.findByLeagueAndUser.mockResolvedValue(null);

      await expect(draftPickService.makePick(1, 1, 'user-123', 100)).rejects.toThrow(
        ForbiddenException
      );
      await expect(draftPickService.makePick(1, 1, 'user-123', 100)).rejects.toThrow(
        'not in this league'
      );
    });

    it('should throw ValidationException when not user turn', async () => {
      mockLeagueRepo.isUserMember.mockResolvedValue(true);
      const otherRoster = { ...mockRoster, id: 99 };
      mockDraftRepo.findByIdWithClient.mockResolvedValue(mockDraft);
      mockRosterRepo.findByLeagueAndUser.mockResolvedValue(otherRoster);
      mockDraftRepo.getDraftOrderWithClient.mockResolvedValue(mockDraftOrder);

      await expect(draftPickService.makePick(1, 1, 'user-123', 100)).rejects.toThrow(
        ValidationException
      );
      await expect(draftPickService.makePick(1, 1, 'user-123', 100)).rejects.toThrow(
        'not your turn'
      );
    });

    it('should throw ConflictException when player already drafted', async () => {
      mockLeagueRepo.isUserMember.mockResolvedValue(true);
      mockDraftRepo.findByIdWithClient.mockResolvedValue(mockDraft);
      mockRosterRepo.findByLeagueAndUser.mockResolvedValue(mockRoster);
      mockDraftRepo.getDraftOrderWithClient.mockResolvedValue(mockDraftOrder);
      // The check is now inside the atomic repository transaction
      mockDraftRepo.makePickAndAdvanceTxWithClient.mockRejectedValue(
        new ConflictException('Player has already been drafted')
      );

      await expect(draftPickService.makePick(1, 1, 'user-123', 100)).rejects.toThrow(
        ConflictException
      );
      await expect(draftPickService.makePick(1, 1, 'user-123', 100)).rejects.toThrow(
        'already been drafted'
      );
    });

    it('should complete draft when all picks are made', async () => {
      mockLeagueRepo.isUserMember.mockResolvedValue(true);
      // For pick 45 (last pick): round 15 (odd), pick in round = 3
      // In normal order (odd round), position 3 picks
      const lastPickDraft = {
        ...mockDraft,
        currentPick: 45, // 3 teams * 15 rounds = 45 total picks
        currentRound: 15,
        currentRosterId: 3, // roster at position 3
      };
      const completedDraft = {
        ...lastPickDraft,
        status: 'completed' as const,
        completedAt: new Date(),
      };
      // User's roster must be the one at position 3
      const lastPickRoster = { ...mockRoster, id: 3 };
      mockDraftRepo.findByIdWithClient.mockResolvedValue(lastPickDraft);
      mockRosterRepo.findByLeagueAndUser.mockResolvedValue(lastPickRoster);
      mockDraftRepo.getDraftOrderWithClient.mockResolvedValue(mockDraftOrder);
      mockDraftRepo.makePickAndAdvanceTxWithClient.mockResolvedValue({
        pick: mockPick,
        draft: completedDraft,
      });
      mockDraftRepo.getDraftPicks.mockResolvedValue([mockPick]);
      mockLeagueRepo.findById.mockResolvedValue({ id: 1, season: '2024' } as any);

      await draftPickService.makePick(1, 1, 'user-123', 100);

      // Should call atomic method with completed status in nextPickState
      expect(mockDraftRepo.makePickAndAdvanceTxWithClient).toHaveBeenCalledWith(
        mockClient,
        expect.objectContaining({
          nextPickState: expect.objectContaining({
            status: 'completed',
          }),
        })
      );
    });
  });

  describe('makePick - race condition handling', () => {
    it('should throw ConflictException when pick number already taken (concurrent pick)', async () => {
      mockLeagueRepo.isUserMember.mockResolvedValue(true);
      mockDraftRepo.findByIdWithClient.mockResolvedValue(mockDraft);
      mockRosterRepo.findByLeagueAndUser.mockResolvedValue(mockRoster);
      mockDraftRepo.getDraftOrderWithClient.mockResolvedValue(mockDraftOrder);
      // Simulate race condition: atomic transaction fails because another request
      // already made the pick (current_pick no longer matches expected)
      mockDraftRepo.makePickAndAdvanceTxWithClient.mockRejectedValue(
        new ConflictException('Pick already made for this position')
      );

      await expect(draftPickService.makePick(1, 1, 'user-123', 100)).rejects.toThrow(
        ConflictException
      );
      await expect(draftPickService.makePick(1, 1, 'user-123', 100)).rejects.toThrow(
        'Pick already made'
      );
    });

    it('should call makePickAndAdvanceTxWithClient with expectedPickNumber for atomicity', async () => {
      mockLeagueRepo.isUserMember.mockResolvedValue(true);
      const draftAtPick5 = { ...mockDraft, currentPick: 5, currentRound: 2, currentRosterId: 2 };
      mockDraftRepo.findByIdWithClient.mockResolvedValue(draftAtPick5);
      // User 2's roster is id: 2
      const roster2 = { ...mockRoster, id: 2 };
      mockRosterRepo.findByLeagueAndUser.mockResolvedValue(roster2);
      mockDraftRepo.getDraftOrderWithClient.mockResolvedValue(mockDraftOrder);
      const updatedDraft = { ...draftAtPick5, currentPick: 6 };
      mockDraftRepo.makePickAndAdvanceTxWithClient.mockResolvedValue({
        pick: { ...mockPick, pickNumber: 5 },
        draft: updatedDraft,
      });

      await draftPickService.makePick(1, 1, 'user-123', 100);

      // Verify the expectedPickNumber is passed to prevent race conditions
      expect(mockDraftRepo.makePickAndAdvanceTxWithClient).toHaveBeenCalledWith(
        mockClient,
        expect.objectContaining({
          expectedPickNumber: 5,
        })
      );
    });

    it('should handle idempotent retries with same idempotencyKey', async () => {
      mockLeagueRepo.isUserMember.mockResolvedValue(true);
      mockDraftRepo.findByIdWithClient.mockResolvedValue(mockDraft);
      mockRosterRepo.findByLeagueAndUser.mockResolvedValue(mockRoster);
      mockDraftRepo.getDraftOrderWithClient.mockResolvedValue(mockDraftOrder);
      const updatedDraft = { ...mockDraft, currentPick: 2 };
      mockDraftRepo.makePickAndAdvanceTxWithClient.mockResolvedValue({ pick: mockPick, draft: updatedDraft });

      const idempotencyKey = 'unique-request-123';
      await draftPickService.makePick(1, 1, 'user-123', 100, idempotencyKey);

      // Verify idempotencyKey is passed through to the atomic method
      expect(mockDraftRepo.makePickAndAdvanceTxWithClient).toHaveBeenCalledWith(
        mockClient,
        expect.objectContaining({
          idempotencyKey: 'unique-request-123',
        })
      );
    });
  });
});
