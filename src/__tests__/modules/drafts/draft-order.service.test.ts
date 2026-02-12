import { Pool, PoolClient } from 'pg';
import { DraftOrderService } from '../../../modules/drafts/draft-order.service';
import { DraftRepository } from '../../../modules/drafts/drafts.repository';
import { DraftPickAssetRepository } from '../../../modules/drafts/draft-pick-asset.repository';
import { LeagueRepository, RosterRepository } from '../../../modules/leagues/leagues.repository';
import { Draft, DraftOrderEntry } from '../../../modules/drafts/drafts.model';
import { DraftPickAssetWithDetails } from '../../../modules/drafts/draft-pick-asset.model';
import { ForbiddenException, ValidationException } from '../../../utils/exceptions';

// Mock Pool
const createMockPool = (): jest.Mocked<Pool> =>
  ({
    connect: jest.fn().mockResolvedValue({
      query: jest.fn().mockResolvedValue({ rows: [] }),
      release: jest.fn(),
    } as unknown as PoolClient),
    query: jest.fn(),
  }) as unknown as jest.Mocked<Pool>;

// Mock data
const mockDraft: Draft = {
  id: 1,
  leagueId: 1,
  draftType: 'snake',
  rounds: 15,
  pickTimeSeconds: 90,
  status: 'not_started',
  phase: 'SETUP',
  currentPick: 1,
  currentRound: 1,
  currentRosterId: null,
  pickDeadline: null,
  scheduledStart: null,
  startedAt: null,
  completedAt: null,
  settings: {},
  draftState: {},
  orderConfirmed: false,
  rosterPopulationStatus: null,
  overnightPauseEnabled: false,
  overnightPauseStart: null,
  overnightPauseEnd: null,
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

const mockRosters = [
  { id: 1, leagueId: 1, userId: 'user-1', teamName: 'Team 1', isCommissioner: true },
  { id: 2, leagueId: 1, userId: 'user-2', teamName: 'Team 2', isCommissioner: false },
  { id: 3, leagueId: 1, userId: 'user-3', teamName: 'Team 3', isCommissioner: false },
];

const mockLeague = {
  id: 1,
  name: 'Test League',
  totalRosters: 3,
  season: '2024',
  mode: 'redraft',
};

// Mock repositories
const createMockDraftRepo = (): jest.Mocked<DraftRepository> =>
  ({
    findById: jest.fn(),
    getDraftOrder: jest.fn(),
    createDraftOrder: jest.fn(),
    clearDraftOrder: jest.fn(),
    updateDraftOrderAtomic: jest.fn(),
    setOrderConfirmed: jest.fn(),
  }) as unknown as jest.Mocked<DraftRepository>;

const createMockLeagueRepo = (): jest.Mocked<LeagueRepository> =>
  ({
    isUserMember: jest.fn(),
    isCommissioner: jest.fn(),
    findById: jest.fn(),
  }) as unknown as jest.Mocked<LeagueRepository>;

const createMockRosterRepo = (): jest.Mocked<RosterRepository> =>
  ({
    findByLeagueId: jest.fn(),
    getRosterCount: jest.fn(),
    createEmptyRoster: jest.fn(),
    deleteEmptyRosters: jest.fn(),
  }) as unknown as jest.Mocked<RosterRepository>;

const createMockPickAssetRepo = (): jest.Mocked<DraftPickAssetRepository> =>
  ({
    findByDraftId: jest.fn(),
    getRound1OwnershipOrder: jest.fn(),
    updatePickPositions: jest.fn(),
  }) as unknown as jest.Mocked<DraftPickAssetRepository>;

const mockPickAssets: DraftPickAssetWithDetails[] = [
  {
    id: 1,
    leagueId: 1,
    draftId: 1,
    season: 2024,
    round: 1,
    originalRosterId: 1,
    currentOwnerRosterId: 2,
    originalPickPosition: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    originalTeamName: 'Team 1',
    originalUsername: 'user1',
    currentOwnerTeamName: 'Team 2',
    currentOwnerUsername: 'user2',
  },
  {
    id: 2,
    leagueId: 1,
    draftId: 1,
    season: 2024,
    round: 1,
    originalRosterId: 2,
    currentOwnerRosterId: 3,
    originalPickPosition: 2,
    createdAt: new Date(),
    updatedAt: new Date(),
    originalTeamName: 'Team 2',
    originalUsername: 'user2',
    currentOwnerTeamName: 'Team 3',
    currentOwnerUsername: 'user3',
  },
  {
    id: 3,
    leagueId: 1,
    draftId: 1,
    season: 2024,
    round: 1,
    originalRosterId: 3,
    currentOwnerRosterId: 1,
    originalPickPosition: 3,
    createdAt: new Date(),
    updatedAt: new Date(),
    originalTeamName: 'Team 3',
    originalUsername: 'user3',
    currentOwnerTeamName: 'Team 1',
    currentOwnerUsername: 'user1',
  },
];

describe('DraftOrderService', () => {
  let draftOrderService: DraftOrderService;
  let mockPool: jest.Mocked<Pool>;
  let mockDraftRepo: jest.Mocked<DraftRepository>;
  let mockLeagueRepo: jest.Mocked<LeagueRepository>;
  let mockRosterRepo: jest.Mocked<RosterRepository>;
  let mockPickAssetRepo: jest.Mocked<DraftPickAssetRepository>;

  beforeEach(() => {
    mockPool = createMockPool();
    mockDraftRepo = createMockDraftRepo();
    mockLeagueRepo = createMockLeagueRepo();
    mockRosterRepo = createMockRosterRepo();
    mockPickAssetRepo = createMockPickAssetRepo();
    draftOrderService = new DraftOrderService(
      mockPool,
      mockDraftRepo,
      mockLeagueRepo,
      mockRosterRepo,
      mockPickAssetRepo
    );
  });

  describe('getDraftOrder', () => {
    it('should return draft order when user is member', async () => {
      mockLeagueRepo.isUserMember.mockResolvedValue(true);
      mockDraftRepo.getDraftOrder.mockResolvedValue(mockDraftOrder);

      const result = await draftOrderService.getDraftOrder(1, 1, 'user-123');

      expect(result).toEqual(mockDraftOrder);
      expect(mockLeagueRepo.isUserMember).toHaveBeenCalledWith(1, 'user-123');
      expect(mockDraftRepo.getDraftOrder).toHaveBeenCalledWith(1);
    });

    it('should throw ForbiddenException when user is not a member', async () => {
      mockLeagueRepo.isUserMember.mockResolvedValue(false);

      await expect(draftOrderService.getDraftOrder(1, 1, 'user-123')).rejects.toThrow(
        ForbiddenException
      );
      await expect(draftOrderService.getDraftOrder(1, 1, 'user-123')).rejects.toThrow(
        'not a member'
      );
    });
  });

  describe('randomizeDraftOrder', () => {
    it('should randomize order when user is commissioner', async () => {
      mockLeagueRepo.isCommissioner.mockResolvedValue(true);
      mockDraftRepo.findById.mockResolvedValue(mockDraft);
      mockLeagueRepo.findById.mockResolvedValue(mockLeague as any);
      mockRosterRepo.findByLeagueId.mockResolvedValue(mockRosters as any);
      mockDraftRepo.updateDraftOrderAtomic.mockResolvedValue(undefined);
      mockDraftRepo.setOrderConfirmed.mockResolvedValue(undefined);
      mockDraftRepo.getDraftOrder.mockResolvedValue(mockDraftOrder);

      const result = await draftOrderService.randomizeDraftOrder(1, 1, 'user-123');

      expect(mockDraftRepo.updateDraftOrderAtomic).toHaveBeenCalledWith(1, expect.any(Array));
      expect(mockDraftRepo.setOrderConfirmed).toHaveBeenCalledWith(1, true);
      expect(result).toEqual(mockDraftOrder);
    });

    it('should throw ForbiddenException when user is not commissioner', async () => {
      mockLeagueRepo.isCommissioner.mockResolvedValue(false);

      await expect(draftOrderService.randomizeDraftOrder(1, 1, 'user-123')).rejects.toThrow(
        ForbiddenException
      );
      await expect(draftOrderService.randomizeDraftOrder(1, 1, 'user-123')).rejects.toThrow(
        'commissioner'
      );
    });

    it('should throw ValidationException when draft already started', async () => {
      mockLeagueRepo.isCommissioner.mockResolvedValue(true);
      mockDraftRepo.findById.mockResolvedValue({ ...mockDraft, status: 'in_progress' });

      await expect(draftOrderService.randomizeDraftOrder(1, 1, 'user-123')).rejects.toThrow(
        ValidationException
      );
      await expect(draftOrderService.randomizeDraftOrder(1, 1, 'user-123')).rejects.toThrow(
        'before draft starts'
      );
    });
  });

  describe('createInitialOrder', () => {
    it('should create order for all rosters', async () => {
      mockLeagueRepo.findById.mockResolvedValue(mockLeague as any);
      mockRosterRepo.findByLeagueId.mockResolvedValue(mockRosters as any);
      mockDraftRepo.updateDraftOrderAtomic.mockResolvedValue(undefined);

      await draftOrderService.createInitialOrder(1, 1);

      expect(mockDraftRepo.updateDraftOrderAtomic).toHaveBeenCalledWith(1, [1, 2, 3]);
    });

    it('should create empty rosters when league is not full', async () => {
      const leagueWith3Slots = { ...mockLeague, totalRosters: 3 };

      mockLeagueRepo.findById.mockResolvedValue(leagueWith3Slots as any);
      // getRosterCount returns 2 (inside transaction, only user-owned rosters)
      mockRosterRepo.getRosterCount.mockResolvedValue(2);
      mockRosterRepo.createEmptyRoster.mockResolvedValue(undefined as any);
      mockRosterRepo.deleteEmptyRosters.mockResolvedValue(undefined as any);
      // findByLeagueId is called AFTER transaction, should return all rosters including new empty one
      mockRosterRepo.findByLeagueId.mockResolvedValue(mockRosters as any);
      mockDraftRepo.updateDraftOrderAtomic.mockResolvedValue(undefined);

      await draftOrderService.createInitialOrder(1, 1);

      // Should have created one empty roster for slot 3
      expect(mockRosterRepo.createEmptyRoster).toHaveBeenCalledWith(1, 3, expect.anything());
      expect(mockDraftRepo.updateDraftOrderAtomic).toHaveBeenCalledWith(1, [1, 2, 3]);
    });
  });

  describe('setOrderFromPickOwnership', () => {
    it('should set order based on Round 1 pick ownership', async () => {
      // Pick ownership order: Roster 2 owns pick 1, Roster 3 owns pick 2, Roster 1 owns pick 3
      const ownershipOrder = [2, 3, 1];

      mockLeagueRepo.isCommissioner.mockResolvedValue(true);
      mockDraftRepo.findById.mockResolvedValue(mockDraft);
      mockPickAssetRepo.findByDraftId.mockResolvedValue(mockPickAssets);
      mockPickAssetRepo.getRound1OwnershipOrder.mockResolvedValue(ownershipOrder);
      mockDraftRepo.updateDraftOrderAtomic.mockResolvedValue(undefined);
      mockPickAssetRepo.updatePickPositions.mockResolvedValue(undefined);
      mockDraftRepo.setOrderConfirmed.mockResolvedValue(undefined);
      mockDraftRepo.getDraftOrder.mockResolvedValue(mockDraftOrder);

      const result = await draftOrderService.setOrderFromPickOwnership(1, 1, 'user-123');

      expect(mockPickAssetRepo.findByDraftId).toHaveBeenCalledWith(1);
      expect(mockPickAssetRepo.getRound1OwnershipOrder).toHaveBeenCalledWith(1, 2024);
      expect(mockDraftRepo.updateDraftOrderAtomic).toHaveBeenCalledWith(1, ownershipOrder);
      expect(mockPickAssetRepo.updatePickPositions).toHaveBeenCalledWith(1);
      expect(mockDraftRepo.setOrderConfirmed).toHaveBeenCalledWith(1, true);
      expect(result).toEqual(mockDraftOrder);
    });

    it('should throw ForbiddenException when user is not commissioner', async () => {
      mockLeagueRepo.isCommissioner.mockResolvedValue(false);

      await expect(draftOrderService.setOrderFromPickOwnership(1, 1, 'user-123')).rejects.toThrow(
        ForbiddenException
      );
    });

    it('should throw ValidationException when draft already started', async () => {
      mockLeagueRepo.isCommissioner.mockResolvedValue(true);
      mockDraftRepo.findById.mockResolvedValue({ ...mockDraft, status: 'in_progress' });

      await expect(draftOrderService.setOrderFromPickOwnership(1, 1, 'user-123')).rejects.toThrow(
        ValidationException
      );
    });

    it('should throw ValidationException when no pick assets are linked', async () => {
      mockLeagueRepo.isCommissioner.mockResolvedValue(true);
      mockDraftRepo.findById.mockResolvedValue(mockDraft);
      mockPickAssetRepo.findByDraftId.mockResolvedValue([]);

      await expect(draftOrderService.setOrderFromPickOwnership(1, 1, 'user-123')).rejects.toThrow(
        'No pick assets linked to this draft'
      );
    });

    it('should throw ValidationException when no Round 1 picks found', async () => {
      mockLeagueRepo.isCommissioner.mockResolvedValue(true);
      mockDraftRepo.findById.mockResolvedValue(mockDraft);
      mockPickAssetRepo.findByDraftId.mockResolvedValue(mockPickAssets);
      mockPickAssetRepo.getRound1OwnershipOrder.mockResolvedValue([]);

      await expect(draftOrderService.setOrderFromPickOwnership(1, 1, 'user-123')).rejects.toThrow(
        'No Round 1 pick assets found'
      );
    });
  });
});
