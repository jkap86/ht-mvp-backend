import { AuthorizationService } from '../../../modules/auth/authorization.service';
import { RosterRepository } from '../../../modules/rosters/roster.repository';
import { LeagueRepository } from '../../../modules/leagues/leagues.repository';
import { Roster } from '../../../modules/leagues/leagues.model';
import { ForbiddenException } from '../../../utils/exceptions';

// Helper to build a mock Roster object
const buildMockRoster = (overrides: Partial<Roster> = {}): Roster => ({
  id: 1,
  leagueId: 100,
  userId: 'user-123',
  rosterId: 1,
  settings: {},
  starters: [],
  bench: [],
  createdAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-01-01'),
  ...overrides,
});

// Create mock RosterRepository
const createMockRosterRepository = (): jest.Mocked<RosterRepository> =>
  ({
    findByLeagueAndUser: jest.fn(),
    findByLeagueId: jest.fn(),
    findById: jest.fn(),
    findByIds: jest.fn(),
    findByLeagueAndRosterId: jest.fn(),
    findByLeagueIdWithMembershipCheck: jest.fn(),
    findByLeagueIdWithClient: jest.fn(),
    create: jest.fn(),
    getNextRosterId: jest.fn(),
    getRosterCount: jest.fn(),
    getTotalRosterCount: jest.fn(),
    benchMember: jest.fn(),
    reinstateMember: jest.fn(),
    getNewestMembers: jest.fn(),
    delete: jest.fn(),
    getTeamName: jest.fn(),
    deleteEmptyRosters: jest.fn(),
    createEmptyRoster: jest.fn(),
    findEmptyRoster: jest.fn(),
    assignUserToRoster: jest.fn(),
  }) as unknown as jest.Mocked<RosterRepository>;

// Create mock LeagueRepository
const createMockLeagueRepository = (): jest.Mocked<LeagueRepository> =>
  ({
    findById: jest.fn(),
    findByIdWithUserRoster: jest.fn(),
    findByUserId: jest.fn(),
    create: jest.fn(),
    createWithClient: jest.fn(),
    findByIdWithUserRosterWithClient: jest.fn(),
    updateCommissionerRosterIdWithClient: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    isUserMember: jest.fn(),
    isCommissioner: jest.fn(),
    resetForNewSeason: jest.fn(),
    updateCommissionerRosterId: jest.fn(),
    canChangeLeagueMode: jest.fn(),
    findPublicLeagues: jest.fn(),
    updateSeasonControls: jest.fn(),
  }) as unknown as jest.Mocked<LeagueRepository>;

describe('AuthorizationService', () => {
  let authzService: AuthorizationService;
  let mockRosterRepo: jest.Mocked<RosterRepository>;
  let mockLeagueRepo: jest.Mocked<LeagueRepository>;

  beforeEach(() => {
    mockRosterRepo = createMockRosterRepository();
    mockLeagueRepo = createMockLeagueRepository();
    authzService = new AuthorizationService(mockRosterRepo, mockLeagueRepo);
  });

  describe('ensureLeagueMember', () => {
    it('should return the roster when user is a league member', async () => {
      const roster = buildMockRoster();
      mockRosterRepo.findByLeagueAndUser.mockResolvedValue(roster);

      const result = await authzService.ensureLeagueMember(100, 'user-123');

      expect(result).toBe(roster);
      expect(mockRosterRepo.findByLeagueAndUser).toHaveBeenCalledWith(100, 'user-123');
    });

    it('should throw ForbiddenException when user is not a member', async () => {
      mockRosterRepo.findByLeagueAndUser.mockResolvedValue(null);

      await expect(authzService.ensureLeagueMember(100, 'user-999')).rejects.toThrow(
        ForbiddenException
      );
      await expect(authzService.ensureLeagueMember(100, 'user-999')).rejects.toThrow(
        'You are not a member of this league'
      );
    });
  });

  describe('ensureCommissioner', () => {
    it('should return the roster when user is the commissioner', async () => {
      const roster = buildMockRoster();
      mockRosterRepo.findByLeagueAndUser.mockResolvedValue(roster);
      mockLeagueRepo.isCommissioner.mockResolvedValue(true);

      const result = await authzService.ensureCommissioner(100, 'user-123');

      expect(result).toBe(roster);
      expect(mockRosterRepo.findByLeagueAndUser).toHaveBeenCalledWith(100, 'user-123');
      expect(mockLeagueRepo.isCommissioner).toHaveBeenCalledWith(100, 'user-123');
    });

    it('should throw ForbiddenException when user is a member but not commissioner', async () => {
      const roster = buildMockRoster();
      mockRosterRepo.findByLeagueAndUser.mockResolvedValue(roster);
      mockLeagueRepo.isCommissioner.mockResolvedValue(false);

      await expect(authzService.ensureCommissioner(100, 'user-123')).rejects.toThrow(
        ForbiddenException
      );
      await expect(authzService.ensureCommissioner(100, 'user-123')).rejects.toThrow(
        'Only the commissioner can perform this action'
      );
    });

    it('should throw ForbiddenException when user is not a member at all', async () => {
      mockRosterRepo.findByLeagueAndUser.mockResolvedValue(null);

      await expect(authzService.ensureCommissioner(100, 'user-999')).rejects.toThrow(
        ForbiddenException
      );
      await expect(authzService.ensureCommissioner(100, 'user-999')).rejects.toThrow(
        'You are not a member of this league'
      );
      // isCommissioner should never be called if user is not a member
      expect(mockLeagueRepo.isCommissioner).not.toHaveBeenCalled();
    });
  });

  describe('getLeagueMembership', () => {
    it('should return the roster when user is a member', async () => {
      const roster = buildMockRoster();
      mockRosterRepo.findByLeagueAndUser.mockResolvedValue(roster);

      const result = await authzService.getLeagueMembership(100, 'user-123');

      expect(result).toBe(roster);
      expect(mockRosterRepo.findByLeagueAndUser).toHaveBeenCalledWith(100, 'user-123');
    });

    it('should return null when user is not a member', async () => {
      mockRosterRepo.findByLeagueAndUser.mockResolvedValue(null);

      const result = await authzService.getLeagueMembership(100, 'user-999');

      expect(result).toBeNull();
    });
  });

  describe('isLeagueMember', () => {
    it('should return true when user is a member', async () => {
      mockLeagueRepo.isUserMember.mockResolvedValue(true);

      const result = await authzService.isLeagueMember(100, 'user-123');

      expect(result).toBe(true);
      expect(mockLeagueRepo.isUserMember).toHaveBeenCalledWith(100, 'user-123');
    });

    it('should return false when user is not a member', async () => {
      mockLeagueRepo.isUserMember.mockResolvedValue(false);

      const result = await authzService.isLeagueMember(100, 'user-999');

      expect(result).toBe(false);
    });
  });

  describe('isCommissioner', () => {
    it('should return true when user is the commissioner', async () => {
      mockLeagueRepo.isCommissioner.mockResolvedValue(true);

      const result = await authzService.isCommissioner(100, 'user-123');

      expect(result).toBe(true);
      expect(mockLeagueRepo.isCommissioner).toHaveBeenCalledWith(100, 'user-123');
    });

    it('should return false when user is not the commissioner', async () => {
      mockLeagueRepo.isCommissioner.mockResolvedValue(false);

      const result = await authzService.isCommissioner(100, 'user-456');

      expect(result).toBe(false);
    });
  });

  describe('edge cases', () => {
    describe('user in multiple leagues', () => {
      it('should correctly check membership per league independently', async () => {
        const rosterLeague100 = buildMockRoster({ id: 1, leagueId: 100, rosterId: 1 });
        const rosterLeague200 = buildMockRoster({ id: 2, leagueId: 200, rosterId: 3 });

        // User is a member of league 100
        mockRosterRepo.findByLeagueAndUser.mockImplementation(
          async (leagueId: number, _userId: string) => {
            if (leagueId === 100) return rosterLeague100;
            if (leagueId === 200) return rosterLeague200;
            return null;
          }
        );

        const result100 = await authzService.ensureLeagueMember(100, 'user-123');
        expect(result100).toBe(rosterLeague100);
        expect(result100.leagueId).toBe(100);

        const result200 = await authzService.ensureLeagueMember(200, 'user-123');
        expect(result200).toBe(rosterLeague200);
        expect(result200.leagueId).toBe(200);

        // User is not a member of league 300
        await expect(authzService.ensureLeagueMember(300, 'user-123')).rejects.toThrow(
          ForbiddenException
        );
      });

      it('should be commissioner in one league but not another', async () => {
        const rosterLeague100 = buildMockRoster({ id: 1, leagueId: 100 });
        const rosterLeague200 = buildMockRoster({ id: 2, leagueId: 200 });

        mockRosterRepo.findByLeagueAndUser.mockImplementation(
          async (leagueId: number, _userId: string) => {
            if (leagueId === 100) return rosterLeague100;
            if (leagueId === 200) return rosterLeague200;
            return null;
          }
        );

        mockLeagueRepo.isCommissioner.mockImplementation(
          async (leagueId: number, _userId: string) => {
            return leagueId === 100; // Commissioner only in league 100
          }
        );

        // Commissioner in league 100
        const result = await authzService.ensureCommissioner(100, 'user-123');
        expect(result).toBe(rosterLeague100);

        // Not commissioner in league 200
        await expect(authzService.ensureCommissioner(200, 'user-123')).rejects.toThrow(
          'Only the commissioner can perform this action'
        );
      });
    });

    describe('commissioner transferred', () => {
      it('should deny commissioner access after transfer to another user', async () => {
        const oldCommissionerRoster = buildMockRoster({
          id: 1,
          userId: 'old-commissioner',
        });

        mockRosterRepo.findByLeagueAndUser.mockResolvedValue(oldCommissionerRoster);
        // After transfer, old commissioner is no longer commissioner
        mockLeagueRepo.isCommissioner.mockResolvedValue(false);

        await expect(
          authzService.ensureCommissioner(100, 'old-commissioner')
        ).rejects.toThrow(ForbiddenException);
        await expect(
          authzService.ensureCommissioner(100, 'old-commissioner')
        ).rejects.toThrow('Only the commissioner can perform this action');
      });

      it('should grant commissioner access to the new commissioner after transfer', async () => {
        const newCommissionerRoster = buildMockRoster({
          id: 2,
          userId: 'new-commissioner',
        });

        mockRosterRepo.findByLeagueAndUser.mockResolvedValue(newCommissionerRoster);
        mockLeagueRepo.isCommissioner.mockResolvedValue(true);

        const result = await authzService.ensureCommissioner(100, 'new-commissioner');
        expect(result).toBe(newCommissionerRoster);
      });

      it('should reflect transfer in boolean commissioner check', async () => {
        // Old commissioner check returns false after transfer
        mockLeagueRepo.isCommissioner
          .mockResolvedValueOnce(false)  // old commissioner
          .mockResolvedValueOnce(true);  // new commissioner

        const oldResult = await authzService.isCommissioner(100, 'old-commissioner');
        expect(oldResult).toBe(false);

        const newResult = await authzService.isCommissioner(100, 'new-commissioner');
        expect(newResult).toBe(true);
      });
    });

    describe('null and boundary inputs', () => {
      it('should handle roster with null userId from repository', async () => {
        const rosterNoUser = buildMockRoster({ userId: null });
        mockRosterRepo.findByLeagueAndUser.mockResolvedValue(rosterNoUser);

        // The service returns whatever the repository returns
        const result = await authzService.getLeagueMembership(100, 'user-123');
        expect(result).toBe(rosterNoUser);
        expect(result!.userId).toBeNull();
      });
    });
  });
});
