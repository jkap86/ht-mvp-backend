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
  1                       // commissionerRosterId
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
  findByUserId: jest.fn(),
  findByIdWithUserRoster: jest.fn(),
  isUserMember: jest.fn(),
  isCommissioner: jest.fn(),
  create: jest.fn(),
  update: jest.fn(),
  delete: jest.fn(),
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
});
