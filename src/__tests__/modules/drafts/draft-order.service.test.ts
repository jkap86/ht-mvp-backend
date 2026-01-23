import { DraftOrderService } from '../../../modules/drafts/draft-order.service';
import { DraftRepository } from '../../../modules/drafts/drafts.repository';
import { LeagueRepository, RosterRepository } from '../../../modules/leagues/leagues.repository';
import { Draft, DraftOrderEntry } from '../../../modules/drafts/drafts.model';
import {
  ForbiddenException,
  ValidationException,
} from '../../../utils/exceptions';

// Mock data
const mockDraft: Draft = {
  id: 1,
  leagueId: 1,
  draftType: 'snake',
  rounds: 15,
  pickTimeSeconds: 90,
  status: 'not_started',
  currentPick: 1,
  currentRound: 1,
  currentRosterId: null,
  pickDeadline: null,
  startedAt: null,
  completedAt: null,
  settings: {},
  createdAt: new Date(),
  updatedAt: new Date(),
};

const mockDraftOrder: DraftOrderEntry[] = [
  { id: 1, draftId: 1, rosterId: 1, draftPosition: 1, username: 'user1' },
  { id: 2, draftId: 1, rosterId: 2, draftPosition: 2, username: 'user2' },
  { id: 3, draftId: 1, rosterId: 3, draftPosition: 3, username: 'user3' },
];

const mockRosters = [
  { id: 1, leagueId: 1, userId: 'user-1', teamName: 'Team 1', isCommissioner: true },
  { id: 2, leagueId: 1, userId: 'user-2', teamName: 'Team 2', isCommissioner: false },
  { id: 3, leagueId: 1, userId: 'user-3', teamName: 'Team 3', isCommissioner: false },
];

// Mock repositories
const createMockDraftRepo = (): jest.Mocked<DraftRepository> => ({
  findById: jest.fn(),
  getDraftOrder: jest.fn(),
  createDraftOrder: jest.fn(),
  clearDraftOrder: jest.fn(),
} as unknown as jest.Mocked<DraftRepository>);

const createMockLeagueRepo = (): jest.Mocked<LeagueRepository> => ({
  isUserMember: jest.fn(),
  isCommissioner: jest.fn(),
} as unknown as jest.Mocked<LeagueRepository>);

const createMockRosterRepo = (): jest.Mocked<RosterRepository> => ({
  findByLeagueId: jest.fn(),
} as unknown as jest.Mocked<RosterRepository>);

describe('DraftOrderService', () => {
  let draftOrderService: DraftOrderService;
  let mockDraftRepo: jest.Mocked<DraftRepository>;
  let mockLeagueRepo: jest.Mocked<LeagueRepository>;
  let mockRosterRepo: jest.Mocked<RosterRepository>;

  beforeEach(() => {
    mockDraftRepo = createMockDraftRepo();
    mockLeagueRepo = createMockLeagueRepo();
    mockRosterRepo = createMockRosterRepo();
    draftOrderService = new DraftOrderService(mockDraftRepo, mockLeagueRepo, mockRosterRepo);
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

      await expect(
        draftOrderService.getDraftOrder(1, 1, 'user-123')
      ).rejects.toThrow(ForbiddenException);
      await expect(
        draftOrderService.getDraftOrder(1, 1, 'user-123')
      ).rejects.toThrow('not a member');
    });
  });

  describe('randomizeDraftOrder', () => {
    it('should randomize order when user is commissioner', async () => {
      mockLeagueRepo.isCommissioner.mockResolvedValue(true);
      mockDraftRepo.findById.mockResolvedValue(mockDraft);
      mockRosterRepo.findByLeagueId.mockResolvedValue(mockRosters as any);
      mockDraftRepo.clearDraftOrder.mockResolvedValue(undefined);
      mockDraftRepo.createDraftOrder.mockResolvedValue(undefined);
      mockDraftRepo.getDraftOrder.mockResolvedValue(mockDraftOrder);

      const result = await draftOrderService.randomizeDraftOrder(1, 1, 'user-123');

      expect(mockDraftRepo.clearDraftOrder).toHaveBeenCalledWith(1);
      expect(mockDraftRepo.createDraftOrder).toHaveBeenCalledTimes(3);
      expect(result).toEqual(mockDraftOrder);
    });

    it('should throw ForbiddenException when user is not commissioner', async () => {
      mockLeagueRepo.isCommissioner.mockResolvedValue(false);

      await expect(
        draftOrderService.randomizeDraftOrder(1, 1, 'user-123')
      ).rejects.toThrow(ForbiddenException);
      await expect(
        draftOrderService.randomizeDraftOrder(1, 1, 'user-123')
      ).rejects.toThrow('commissioner');
    });

    it('should throw ValidationException when draft already started', async () => {
      mockLeagueRepo.isCommissioner.mockResolvedValue(true);
      mockDraftRepo.findById.mockResolvedValue({ ...mockDraft, status: 'in_progress' });

      await expect(
        draftOrderService.randomizeDraftOrder(1, 1, 'user-123')
      ).rejects.toThrow(ValidationException);
      await expect(
        draftOrderService.randomizeDraftOrder(1, 1, 'user-123')
      ).rejects.toThrow('before draft starts');
    });
  });

  describe('createInitialOrder', () => {
    it('should create order for all rosters', async () => {
      mockRosterRepo.findByLeagueId.mockResolvedValue(mockRosters as any);
      mockDraftRepo.createDraftOrder.mockResolvedValue(undefined);

      await draftOrderService.createInitialOrder(1, 1);

      expect(mockDraftRepo.createDraftOrder).toHaveBeenCalledTimes(3);
      expect(mockDraftRepo.createDraftOrder).toHaveBeenCalledWith(1, 1, 1);
      expect(mockDraftRepo.createDraftOrder).toHaveBeenCalledWith(1, 2, 2);
      expect(mockDraftRepo.createDraftOrder).toHaveBeenCalledWith(1, 3, 3);
    });
  });
});
