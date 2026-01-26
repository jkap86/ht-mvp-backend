import { LeagueService } from '../../../modules/leagues/leagues.service';
import { LeagueRepository, RosterRepository } from '../../../modules/leagues/leagues.repository';
import { RosterService } from '../../../modules/leagues/roster.service';
import { League } from '../../../modules/leagues/leagues.model';
import {
  NotFoundException,
  ForbiddenException,
  ValidationException,
  ConflictException,
} from '../../../utils/exceptions';

// Create mock league using the actual class constructor
const mockLeague = new League(
  1,                      // id
  'Test League',          // name
  'active',               // status
  {},                     // settings
  { rec: 1.0 },           // scoringSettings
  '2024',                 // season
  10,                     // totalRosters
  new Date(),             // createdAt
  new Date(),             // updatedAt
  1,                      // userRosterId
  1,                      // commissionerRosterId
  'redraft',              // mode
  {},                     // leagueSettings
  1,                      // currentWeek
  'pre_season',           // seasonStatus
  'ABC12345',             // inviteCode
  false                   // isPublic
);

const mockPublicLeague = new League(
  2,                      // id
  'Public League',        // name
  'active',               // status
  {},                     // settings
  { rec: 1.0 },           // scoringSettings
  '2024',                 // season
  12,                     // totalRosters
  new Date(),             // createdAt
  new Date(),             // updatedAt
  undefined,              // userRosterId
  1,                      // commissionerRosterId
  'redraft',              // mode
  {},                     // leagueSettings
  1,                      // currentWeek
  'pre_season',           // seasonStatus
  'XYZ98765',             // inviteCode
  true                    // isPublic
);

const mockRoster = {
  id: 1,
  leagueId: 1,
  userId: 'user-123',
  teamName: 'My Team',
  isCommissioner: true,
  toResponse: () => ({
    id: 1,
    league_id: 1,
    user_id: 'user-123',
    team_name: 'My Team',
    is_commissioner: true,
  }),
};

// Mock repositories
const createMockLeagueRepo = (): jest.Mocked<LeagueRepository> => ({
  findById: jest.fn(),
  findByUserId: jest.fn(),
  findByIdWithUserRoster: jest.fn(),
  findByInviteCode: jest.fn(),
  isUserMember: jest.fn(),
  isCommissioner: jest.fn(),
  create: jest.fn(),
  update: jest.fn(),
  delete: jest.fn(),
  findPublicLeagues: jest.fn(),
} as unknown as jest.Mocked<LeagueRepository>);

const createMockRosterRepo = (): jest.Mocked<RosterRepository> => ({
  findByLeagueAndUser: jest.fn(),
  create: jest.fn(),
  findByLeagueId: jest.fn(),
  countByLeague: jest.fn(),
} as unknown as jest.Mocked<RosterRepository>);

const createMockRosterService = (): jest.Mocked<RosterService> => ({
  createInitialRoster: jest.fn(),
  joinLeague: jest.fn(),
  getLeagueMembers: jest.fn(),
  devBulkAddUsers: jest.fn(),
} as unknown as jest.Mocked<RosterService>);

describe('LeagueService', () => {
  let leagueService: LeagueService;
  let mockLeagueRepo: jest.Mocked<LeagueRepository>;
  let mockRosterRepo: jest.Mocked<RosterRepository>;
  let mockRosterService: jest.Mocked<RosterService>;

  beforeEach(() => {
    mockLeagueRepo = createMockLeagueRepo();
    mockRosterRepo = createMockRosterRepo();
    mockRosterService = createMockRosterService();
    leagueService = new LeagueService(mockLeagueRepo, mockRosterRepo, mockRosterService);
  });

  describe('createLeague', () => {
    it('should create league and commissioner roster on success', async () => {
      mockLeagueRepo.create.mockResolvedValue(mockLeague);
      mockRosterService.createInitialRoster.mockResolvedValue(mockRoster as any);
      mockLeagueRepo.findByIdWithUserRoster.mockResolvedValue(mockLeague);

      const result = await leagueService.createLeague(
        { name: 'Test League', season: '2024', totalRosters: 10 },
        'user-123'
      );

      expect(result.name).toBe('Test League');
      expect(mockLeagueRepo.create).toHaveBeenCalled();
      expect(mockRosterService.createInitialRoster).toHaveBeenCalledWith(1, 'user-123');
    });

    it('should throw ValidationException for empty name', async () => {
      await expect(
        leagueService.createLeague({ name: '', season: '2024', totalRosters: 10 }, 'user-123')
      ).rejects.toThrow(ValidationException);
      await expect(
        leagueService.createLeague({ name: '  ', season: '2024', totalRosters: 10 }, 'user-123')
      ).rejects.toThrow('name is required');
    });

    it('should throw ValidationException for invalid season', async () => {
      await expect(
        leagueService.createLeague({ name: 'Test', season: 'invalid', totalRosters: 10 }, 'user-123')
      ).rejects.toThrow(ValidationException);
      await expect(
        leagueService.createLeague({ name: 'Test', season: 'abc', totalRosters: 10 }, 'user-123')
      ).rejects.toThrow('Valid season year');
    });

    it('should throw ValidationException for invalid roster count', async () => {
      await expect(
        leagueService.createLeague({ name: 'Test', season: '2024', totalRosters: 1 }, 'user-123')
      ).rejects.toThrow(ValidationException);
      await expect(
        leagueService.createLeague({ name: 'Test', season: '2024', totalRosters: 25 }, 'user-123')
      ).rejects.toThrow('between 2 and 20');
    });
  });

  describe('getLeagueById', () => {
    it('should return league when user is member', async () => {
      mockLeagueRepo.findByIdWithUserRoster.mockResolvedValue(mockLeague);
      mockLeagueRepo.isUserMember.mockResolvedValue(true);

      const result = await leagueService.getLeagueById(1, 'user-123');

      expect(result.name).toBe('Test League');
      expect(mockLeagueRepo.findByIdWithUserRoster).toHaveBeenCalledWith(1, 'user-123');
    });

    it('should throw NotFoundException when league not found', async () => {
      mockLeagueRepo.findByIdWithUserRoster.mockResolvedValue(null);

      await expect(
        leagueService.getLeagueById(999, 'user-123')
      ).rejects.toThrow(NotFoundException);
      await expect(
        leagueService.getLeagueById(999, 'user-123')
      ).rejects.toThrow('not found');
    });

    it('should throw ForbiddenException when user is not a member', async () => {
      mockLeagueRepo.findByIdWithUserRoster.mockResolvedValue(mockLeague);
      mockLeagueRepo.isUserMember.mockResolvedValue(false);

      await expect(
        leagueService.getLeagueById(1, 'other-user')
      ).rejects.toThrow(ForbiddenException);
      await expect(
        leagueService.getLeagueById(1, 'other-user')
      ).rejects.toThrow('not a member');
    });
  });

  describe('joinLeague', () => {
    it('should delegate to RosterService', async () => {
      const mockResult = { message: 'Joined', roster: mockRoster };
      mockRosterService.joinLeague.mockResolvedValue(mockResult);

      const result = await leagueService.joinLeague(1, 'user-456');

      expect(mockRosterService.joinLeague).toHaveBeenCalledWith(1, 'user-456');
      expect(result).toEqual(mockResult);
    });
  });

  describe('updateLeague', () => {
    it('should update league when user is commissioner', async () => {
      mockLeagueRepo.isCommissioner.mockResolvedValue(true);
      mockLeagueRepo.update.mockResolvedValue(mockLeague);

      const result = await leagueService.updateLeague(1, 'user-123', { name: 'Updated Name' });

      expect(mockLeagueRepo.update).toHaveBeenCalledWith(1, { name: 'Updated Name' });
    });

    it('should throw ForbiddenException when not commissioner', async () => {
      mockLeagueRepo.isCommissioner.mockResolvedValue(false);

      await expect(
        leagueService.updateLeague(1, 'other-user', { name: 'Updated' })
      ).rejects.toThrow(ForbiddenException);
      await expect(
        leagueService.updateLeague(1, 'other-user', { name: 'Updated' })
      ).rejects.toThrow('commissioner');
    });
  });

  describe('deleteLeague', () => {
    it('should delete league when user is commissioner', async () => {
      mockLeagueRepo.isCommissioner.mockResolvedValue(true);
      mockLeagueRepo.delete.mockResolvedValue(undefined);

      await leagueService.deleteLeague(1, 'user-123');

      expect(mockLeagueRepo.delete).toHaveBeenCalledWith(1);
    });

    it('should throw ForbiddenException when not commissioner', async () => {
      mockLeagueRepo.isCommissioner.mockResolvedValue(false);

      await expect(
        leagueService.deleteLeague(1, 'other-user')
      ).rejects.toThrow(ForbiddenException);
      await expect(
        leagueService.deleteLeague(1, 'other-user')
      ).rejects.toThrow('commissioner');
    });
  });

  describe('discoverPublicLeagues', () => {
    it('should return public leagues from repository', async () => {
      const mockPublicLeagues = [
        { id: 1, name: 'Public League 1', member_count: 5, total_rosters: 10 },
        { id: 2, name: 'Public League 2', member_count: 8, total_rosters: 12 },
      ];
      mockLeagueRepo.findPublicLeagues.mockResolvedValue(mockPublicLeagues);

      const result = await leagueService.discoverPublicLeagues('user-123');

      expect(mockLeagueRepo.findPublicLeagues).toHaveBeenCalledWith('user-123', undefined, undefined);
      expect(result).toEqual(mockPublicLeagues);
    });

    it('should pass limit and offset to repository', async () => {
      mockLeagueRepo.findPublicLeagues.mockResolvedValue([]);

      await leagueService.discoverPublicLeagues('user-123', 10, 20);

      expect(mockLeagueRepo.findPublicLeagues).toHaveBeenCalledWith('user-123', 10, 20);
    });
  });

  describe('joinPublicLeague', () => {
    it('should allow joining a public league', async () => {
      mockLeagueRepo.findById.mockResolvedValue(mockPublicLeague);
      mockRosterService.joinLeague.mockResolvedValue({ message: 'Joined', roster: mockRoster });
      mockLeagueRepo.findByIdWithUserRoster.mockResolvedValue(mockPublicLeague);

      const result = await leagueService.joinPublicLeague(2, 'user-456');

      expect(mockLeagueRepo.findById).toHaveBeenCalledWith(2);
      expect(mockRosterService.joinLeague).toHaveBeenCalledWith(2, 'user-456');
      expect(result.name).toBe('Public League');
    });

    it('should throw NotFoundException when league not found', async () => {
      mockLeagueRepo.findById.mockResolvedValue(null);

      await expect(
        leagueService.joinPublicLeague(999, 'user-123')
      ).rejects.toThrow(NotFoundException);
      await expect(
        leagueService.joinPublicLeague(999, 'user-123')
      ).rejects.toThrow('not found');
    });

    it('should throw ForbiddenException when joining a private league', async () => {
      mockLeagueRepo.findById.mockResolvedValue(mockLeague); // mockLeague has isPublic: false

      await expect(
        leagueService.joinPublicLeague(1, 'user-456')
      ).rejects.toThrow(ForbiddenException);
      await expect(
        leagueService.joinPublicLeague(1, 'user-456')
      ).rejects.toThrow('private');
    });
  });

  describe('createLeague with isPublic', () => {
    it('should create a public league when isPublic is true', async () => {
      mockLeagueRepo.create.mockResolvedValue(mockPublicLeague);
      mockRosterService.createInitialRoster.mockResolvedValue(mockRoster as any);
      mockLeagueRepo.findByIdWithUserRoster.mockResolvedValue(mockPublicLeague);

      const result = await leagueService.createLeague(
        { name: 'Public League', season: '2024', totalRosters: 12, isPublic: true },
        'user-123'
      );

      expect(mockLeagueRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ isPublic: true })
      );
      expect(result.is_public).toBe(true);
    });

    it('should create a private league by default', async () => {
      mockLeagueRepo.create.mockResolvedValue(mockLeague);
      mockRosterService.createInitialRoster.mockResolvedValue(mockRoster as any);
      mockLeagueRepo.findByIdWithUserRoster.mockResolvedValue(mockLeague);

      await leagueService.createLeague(
        { name: 'Test League', season: '2024', totalRosters: 10 },
        'user-123'
      );

      expect(mockLeagueRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ isPublic: false })
      );
    });
  });
});
