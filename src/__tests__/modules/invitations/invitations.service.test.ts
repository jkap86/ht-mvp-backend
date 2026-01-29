import { InvitationsService } from '../../../modules/invitations/invitations.service';
import { InvitationsRepository } from '../../../modules/invitations/invitations.repository';
import { LeagueRepository, RosterRepository } from '../../../modules/leagues/leagues.repository';
import { UserRepository } from '../../../modules/auth/auth.repository';
import { RosterService } from '../../../modules/leagues/roster.service';
import {
  LeagueInvitation,
  InvitationWithDetails,
  UserSearchResult,
} from '../../../modules/invitations/invitations.model';
import {
  NotFoundException,
  ForbiddenException,
  ConflictException,
  ValidationException,
} from '../../../utils/exceptions';

// Mock socket service
jest.mock('../../../socket/socket.service', () => ({
  tryGetSocketService: jest.fn(() => ({
    emitToUser: jest.fn(),
  })),
}));

// Mock data
const mockInvitation: LeagueInvitation = {
  id: 1,
  leagueId: 1,
  invitedUserId: 'user-456',
  invitedByUserId: 'user-123',
  status: 'pending',
  message: 'Join our league!',
  createdAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-01-01'),
  respondedAt: null,
  expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
};

const mockInvitationWithDetails: InvitationWithDetails = {
  ...mockInvitation,
  leagueName: 'Test League',
  leagueSeason: '2026',
  leagueMode: 'redraft',
  invitedByUsername: 'commissioner',
  memberCount: 5,
  totalRosters: 12,
};

const mockLeague = {
  id: 1,
  name: 'Test League',
  season: '2026',
  totalRosters: 12,
  toResponse: jest.fn(),
};

const mockUser = {
  userId: 'user-456',
  username: 'inviteduser',
  email: 'invited@test.com',
};

// Create mock repositories
const createMockInvitationsRepo = (): jest.Mocked<InvitationsRepository> =>
  ({
    create: jest.fn(),
    findById: jest.fn(),
    findByIdWithDetails: jest.fn(),
    findPendingByUserId: jest.fn(),
    findByLeagueId: jest.fn(),
    hasPendingInvite: jest.fn(),
    updateStatus: jest.fn(),
    delete: jest.fn(),
    expireOldInvitations: jest.fn(),
    searchUsersForInvite: jest.fn(),
  }) as unknown as jest.Mocked<InvitationsRepository>;

const createMockLeagueRepo = (): jest.Mocked<LeagueRepository> =>
  ({
    isCommissioner: jest.fn(),
    findById: jest.fn(),
    findByIdWithUserRoster: jest.fn(),
    isUserMember: jest.fn(),
  }) as unknown as jest.Mocked<LeagueRepository>;

const createMockRosterRepo = (): jest.Mocked<RosterRepository> =>
  ({
    getRosterCount: jest.fn(),
  }) as unknown as jest.Mocked<RosterRepository>;

const createMockUserRepo = (): jest.Mocked<UserRepository> =>
  ({
    findByUsername: jest.fn(),
    findById: jest.fn(),
  }) as unknown as jest.Mocked<UserRepository>;

const createMockRosterService = (): jest.Mocked<RosterService> =>
  ({
    joinLeague: jest.fn(),
  }) as unknown as jest.Mocked<RosterService>;

describe('InvitationsService', () => {
  let invitationsService: InvitationsService;
  let mockInvitationsRepo: jest.Mocked<InvitationsRepository>;
  let mockLeagueRepo: jest.Mocked<LeagueRepository>;
  let mockRosterRepo: jest.Mocked<RosterRepository>;
  let mockUserRepo: jest.Mocked<UserRepository>;
  let mockRosterService: jest.Mocked<RosterService>;

  beforeEach(() => {
    mockInvitationsRepo = createMockInvitationsRepo();
    mockLeagueRepo = createMockLeagueRepo();
    mockRosterRepo = createMockRosterRepo();
    mockUserRepo = createMockUserRepo();
    mockRosterService = createMockRosterService();

    invitationsService = new InvitationsService(
      mockInvitationsRepo,
      mockLeagueRepo,
      mockRosterRepo,
      mockUserRepo,
      mockRosterService
    );
  });

  describe('sendInvitation', () => {
    it('should create invitation when league member sends to valid user', async () => {
      // First isUserMember call is for verifying sender is a member
      // Second isUserMember call is for checking if invited user is already a member
      mockLeagueRepo.isUserMember
        .mockResolvedValueOnce(true) // sender is member
        .mockResolvedValueOnce(false); // invited user is not member
      mockLeagueRepo.findById.mockResolvedValue(mockLeague as any);
      mockUserRepo.findByUsername.mockResolvedValue(mockUser as any);
      mockInvitationsRepo.hasPendingInvite.mockResolvedValue(false);
      mockRosterRepo.getRosterCount.mockResolvedValue(5);
      mockInvitationsRepo.create.mockResolvedValue(mockInvitation);
      mockInvitationsRepo.findByIdWithDetails.mockResolvedValue(mockInvitationWithDetails);

      const result = await invitationsService.sendInvitation(
        1,
        'inviteduser',
        'user-123',
        'Join our league!'
      );

      expect(result.leagueName).toBe('Test League');
      expect(result.invitedByUsername).toBe('commissioner');
      expect(mockInvitationsRepo.create).toHaveBeenCalledWith({
        leagueId: 1,
        invitedUserId: 'user-456',
        invitedByUserId: 'user-123',
        message: 'Join our league!',
      });
    });

    it('should throw ForbiddenException when non-member tries to send', async () => {
      mockLeagueRepo.isUserMember.mockResolvedValue(false);

      await expect(invitationsService.sendInvitation(1, 'inviteduser', 'user-999')).rejects.toThrow(
        ForbiddenException
      );
      await expect(invitationsService.sendInvitation(1, 'inviteduser', 'user-999')).rejects.toThrow(
        'Only league members can send invitations'
      );
    });

    it('should throw NotFoundException when league not found', async () => {
      mockLeagueRepo.isUserMember.mockResolvedValue(true);
      mockLeagueRepo.findById.mockResolvedValue(null);

      await expect(
        invitationsService.sendInvitation(999, 'inviteduser', 'user-123')
      ).rejects.toThrow(NotFoundException);
      await expect(
        invitationsService.sendInvitation(999, 'inviteduser', 'user-123')
      ).rejects.toThrow('League not found');
    });

    it('should throw NotFoundException when invited user does not exist', async () => {
      mockLeagueRepo.isUserMember.mockResolvedValue(true);
      mockLeagueRepo.findById.mockResolvedValue(mockLeague as any);
      mockUserRepo.findByUsername.mockResolvedValue(null);

      await expect(invitationsService.sendInvitation(1, 'nonexistent', 'user-123')).rejects.toThrow(
        NotFoundException
      );
      await expect(invitationsService.sendInvitation(1, 'nonexistent', 'user-123')).rejects.toThrow(
        "User 'nonexistent' not found"
      );
    });

    it('should throw ValidationException when inviting yourself', async () => {
      mockLeagueRepo.isUserMember.mockResolvedValue(true);
      mockLeagueRepo.findById.mockResolvedValue(mockLeague as any);
      mockUserRepo.findByUsername.mockResolvedValue({ userId: 'user-123' } as any);

      await expect(invitationsService.sendInvitation(1, 'myself', 'user-123')).rejects.toThrow(
        ValidationException
      );
      await expect(invitationsService.sendInvitation(1, 'myself', 'user-123')).rejects.toThrow(
        'You cannot invite yourself'
      );
    });

    it('should throw ConflictException when user is already a member', async () => {
      mockLeagueRepo.isUserMember
        .mockResolvedValueOnce(true) // sender is member (1st call)
        .mockResolvedValueOnce(true) // invited user is also a member (1st call)
        .mockResolvedValueOnce(true) // sender is member (2nd call)
        .mockResolvedValueOnce(true); // invited user is also a member (2nd call)
      mockLeagueRepo.findById.mockResolvedValue(mockLeague as any);
      mockUserRepo.findByUsername.mockResolvedValue(mockUser as any);

      await expect(invitationsService.sendInvitation(1, 'inviteduser', 'user-123')).rejects.toThrow(
        ConflictException
      );
      await expect(invitationsService.sendInvitation(1, 'inviteduser', 'user-123')).rejects.toThrow(
        'inviteduser is already a member of this league'
      );
    });

    it('should throw ConflictException when pending invite already exists', async () => {
      mockLeagueRepo.isUserMember
        .mockResolvedValueOnce(true) // sender is member (1st call)
        .mockResolvedValueOnce(false) // invited user is not member (1st call)
        .mockResolvedValueOnce(true) // sender is member (2nd call)
        .mockResolvedValueOnce(false); // invited user is not member (2nd call)
      mockLeagueRepo.findById.mockResolvedValue(mockLeague as any);
      mockUserRepo.findByUsername.mockResolvedValue(mockUser as any);
      mockInvitationsRepo.hasPendingInvite.mockResolvedValue(true);

      await expect(invitationsService.sendInvitation(1, 'inviteduser', 'user-123')).rejects.toThrow(
        ConflictException
      );
      await expect(invitationsService.sendInvitation(1, 'inviteduser', 'user-123')).rejects.toThrow(
        'inviteduser already has a pending invitation'
      );
    });

    it('should throw ConflictException when league is full', async () => {
      mockLeagueRepo.isUserMember
        .mockResolvedValueOnce(true) // sender is member (1st call)
        .mockResolvedValueOnce(false) // invited user is not member (1st call)
        .mockResolvedValueOnce(true) // sender is member (2nd call)
        .mockResolvedValueOnce(false); // invited user is not member (2nd call)
      mockLeagueRepo.findById.mockResolvedValue(mockLeague as any);
      mockUserRepo.findByUsername.mockResolvedValue(mockUser as any);
      mockInvitationsRepo.hasPendingInvite.mockResolvedValue(false);
      mockRosterRepo.getRosterCount.mockResolvedValue(12); // League is full

      await expect(invitationsService.sendInvitation(1, 'inviteduser', 'user-123')).rejects.toThrow(
        ConflictException
      );
      await expect(invitationsService.sendInvitation(1, 'inviteduser', 'user-123')).rejects.toThrow(
        'League is full'
      );
    });
  });

  describe('getMyPendingInvitations', () => {
    it('should return list of pending invitations for user', async () => {
      mockInvitationsRepo.findPendingByUserId.mockResolvedValue([mockInvitationWithDetails]);

      const result = await invitationsService.getMyPendingInvitations('user-456');

      expect(result).toHaveLength(1);
      expect(result[0].leagueName).toBe('Test League');
      expect(mockInvitationsRepo.findPendingByUserId).toHaveBeenCalledWith('user-456');
    });

    it('should return empty list when no invitations', async () => {
      mockInvitationsRepo.findPendingByUserId.mockResolvedValue([]);

      const result = await invitationsService.getMyPendingInvitations('user-456');

      expect(result).toHaveLength(0);
    });
  });

  describe('acceptInvitation', () => {
    it('should add user to league and update invitation status', async () => {
      mockInvitationsRepo.findById.mockResolvedValue(mockInvitation);
      mockRosterService.joinLeague.mockResolvedValue({ message: 'Joined successfully' } as any);
      mockInvitationsRepo.updateStatus.mockResolvedValue({ ...mockInvitation, status: 'accepted' });
      mockLeagueRepo.findByIdWithUserRoster.mockResolvedValue(mockLeague as any);

      const result = await invitationsService.acceptInvitation(1, 'user-456');

      expect(result.message).toBe('Joined successfully');
      expect(mockRosterService.joinLeague).toHaveBeenCalledWith(1, 'user-456');
      expect(mockInvitationsRepo.updateStatus).toHaveBeenCalledWith(1, 'accepted');
    });

    it('should throw NotFoundException when invitation not found', async () => {
      mockInvitationsRepo.findById.mockResolvedValue(null);

      await expect(invitationsService.acceptInvitation(999, 'user-456')).rejects.toThrow(
        NotFoundException
      );
      await expect(invitationsService.acceptInvitation(999, 'user-456')).rejects.toThrow(
        'Invitation not found'
      );
    });

    it('should throw ForbiddenException when user is not the invitee', async () => {
      mockInvitationsRepo.findById.mockResolvedValue(mockInvitation);

      await expect(invitationsService.acceptInvitation(1, 'user-999')).rejects.toThrow(
        ForbiddenException
      );
      await expect(invitationsService.acceptInvitation(1, 'user-999')).rejects.toThrow(
        'This invitation was not sent to you'
      );
    });

    it('should throw ValidationException when invitation already responded', async () => {
      mockInvitationsRepo.findById.mockResolvedValue({
        ...mockInvitation,
        status: 'accepted',
      });

      await expect(invitationsService.acceptInvitation(1, 'user-456')).rejects.toThrow(
        ValidationException
      );
      await expect(invitationsService.acceptInvitation(1, 'user-456')).rejects.toThrow(
        'Invitation has already been accepted'
      );
    });

    it('should throw ValidationException when invitation is expired', async () => {
      mockInvitationsRepo.findById.mockResolvedValue({
        ...mockInvitation,
        expiresAt: new Date('2020-01-01'), // In the past
      });

      await expect(invitationsService.acceptInvitation(1, 'user-456')).rejects.toThrow(
        ValidationException
      );
      await expect(invitationsService.acceptInvitation(1, 'user-456')).rejects.toThrow(
        'Invitation has expired'
      );
    });
  });

  describe('declineInvitation', () => {
    it('should update invitation status to declined', async () => {
      mockInvitationsRepo.findByIdWithDetails.mockResolvedValue(mockInvitationWithDetails);
      mockInvitationsRepo.updateStatus.mockResolvedValue({ ...mockInvitation, status: 'declined' });

      await invitationsService.declineInvitation(1, 'user-456');

      expect(mockInvitationsRepo.updateStatus).toHaveBeenCalledWith(1, 'declined');
    });

    it('should throw NotFoundException when invitation not found', async () => {
      mockInvitationsRepo.findByIdWithDetails.mockResolvedValue(null);

      await expect(invitationsService.declineInvitation(999, 'user-456')).rejects.toThrow(
        NotFoundException
      );
      await expect(invitationsService.declineInvitation(999, 'user-456')).rejects.toThrow(
        'Invitation not found'
      );
    });

    it('should throw ForbiddenException when user is not the invitee', async () => {
      mockInvitationsRepo.findByIdWithDetails.mockResolvedValue(mockInvitationWithDetails);

      await expect(invitationsService.declineInvitation(1, 'user-999')).rejects.toThrow(
        ForbiddenException
      );
      await expect(invitationsService.declineInvitation(1, 'user-999')).rejects.toThrow(
        'This invitation was not sent to you'
      );
    });
  });

  describe('cancelInvitation', () => {
    it('should delete invitation when commissioner cancels', async () => {
      mockInvitationsRepo.findById.mockResolvedValue(mockInvitation);
      mockLeagueRepo.isCommissioner.mockResolvedValue(true);
      mockInvitationsRepo.delete.mockResolvedValue(true);

      await invitationsService.cancelInvitation(1, 'user-123');

      expect(mockInvitationsRepo.delete).toHaveBeenCalledWith(1);
    });

    it('should throw NotFoundException when invitation not found', async () => {
      mockInvitationsRepo.findById.mockResolvedValue(null);

      await expect(invitationsService.cancelInvitation(999, 'user-123')).rejects.toThrow(
        NotFoundException
      );
      await expect(invitationsService.cancelInvitation(999, 'user-123')).rejects.toThrow(
        'Invitation not found'
      );
    });

    it('should throw ForbiddenException when non-commissioner cancels', async () => {
      mockInvitationsRepo.findById.mockResolvedValue(mockInvitation);
      mockLeagueRepo.isCommissioner.mockResolvedValue(false);

      await expect(invitationsService.cancelInvitation(1, 'user-999')).rejects.toThrow(
        ForbiddenException
      );
      await expect(invitationsService.cancelInvitation(1, 'user-999')).rejects.toThrow(
        'Only the commissioner can cancel invitations'
      );
    });

    it('should throw ValidationException when invitation already responded', async () => {
      mockInvitationsRepo.findById.mockResolvedValue({
        ...mockInvitation,
        status: 'declined',
      });
      mockLeagueRepo.isCommissioner.mockResolvedValue(true);

      await expect(invitationsService.cancelInvitation(1, 'user-123')).rejects.toThrow(
        ValidationException
      );
      await expect(invitationsService.cancelInvitation(1, 'user-123')).rejects.toThrow(
        'Invitation has already been declined'
      );
    });
  });

  describe('searchUsersForInvite', () => {
    const mockSearchResults: UserSearchResult[] = [
      { id: 'user-1', username: 'john', hasPendingInvite: false, isMember: false },
      { id: 'user-2', username: 'jane', hasPendingInvite: true, isMember: false },
      { id: 'user-3', username: 'jack', hasPendingInvite: false, isMember: true },
    ];

    it('should return users matching query', async () => {
      mockLeagueRepo.isUserMember.mockResolvedValue(true);
      mockInvitationsRepo.searchUsersForInvite.mockResolvedValue(mockSearchResults);

      const result = await invitationsService.searchUsersForInvite(1, 'jo', 'user-123');

      expect(result).toHaveLength(3);
      expect(result[0].username).toBe('john');
      expect(mockInvitationsRepo.searchUsersForInvite).toHaveBeenCalledWith(1, 'jo');
    });

    it('should mark users as members or already invited', async () => {
      mockLeagueRepo.isUserMember.mockResolvedValue(true);
      mockInvitationsRepo.searchUsersForInvite.mockResolvedValue(mockSearchResults);

      const result = await invitationsService.searchUsersForInvite(1, 'ja', 'user-123');

      const jane = result.find((u) => u.username === 'jane');
      const jack = result.find((u) => u.username === 'jack');
      expect(jane?.hasPendingInvite).toBe(true);
      expect(jack?.isMember).toBe(true);
    });

    it('should throw ForbiddenException when non-member searches', async () => {
      mockLeagueRepo.isUserMember.mockResolvedValue(false);

      await expect(invitationsService.searchUsersForInvite(1, 'john', 'user-999')).rejects.toThrow(
        ForbiddenException
      );
      await expect(invitationsService.searchUsersForInvite(1, 'john', 'user-999')).rejects.toThrow(
        'Only league members can search for users to invite'
      );
    });

    it('should throw ValidationException when query too short', async () => {
      mockLeagueRepo.isUserMember.mockResolvedValue(true);

      await expect(invitationsService.searchUsersForInvite(1, 'j', 'user-123')).rejects.toThrow(
        ValidationException
      );
      await expect(invitationsService.searchUsersForInvite(1, 'j', 'user-123')).rejects.toThrow(
        'Search query must be at least 2 characters'
      );
    });
  });

  describe('getLeaguePendingInvitations', () => {
    it('should return pending invitations for league', async () => {
      mockLeagueRepo.isUserMember.mockResolvedValue(true);
      mockInvitationsRepo.findByLeagueId.mockResolvedValue([mockInvitationWithDetails]);

      const result = await invitationsService.getLeaguePendingInvitations(1, 'user-123');

      expect(result).toHaveLength(1);
      expect(mockInvitationsRepo.findByLeagueId).toHaveBeenCalledWith(1);
    });

    it('should throw ForbiddenException when non-member views', async () => {
      mockLeagueRepo.isUserMember.mockResolvedValue(false);

      await expect(invitationsService.getLeaguePendingInvitations(1, 'user-999')).rejects.toThrow(
        ForbiddenException
      );
      await expect(invitationsService.getLeaguePendingInvitations(1, 'user-999')).rejects.toThrow(
        'Only league members can view league invitations'
      );
    });
  });
});
