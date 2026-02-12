import { Response } from 'express';
import { AuthRequest } from '../../../middleware/auth.middleware';
import { ActivityController } from '../../../modules/leagues/activity.controller';
import { ActivityService } from '../../../modules/leagues/activity.service';
import { AuthorizationService } from '../../../modules/auth/authorization.service';
import { RosterRepository } from '../../../modules/rosters/roster.repository';
import { ForbiddenException } from '../../../utils/exceptions';

// Minimal mocks
const mockActivityService = {
  getLeagueActivity: jest.fn().mockResolvedValue([]),
  getRosterActivity: jest.fn().mockResolvedValue([]),
} as unknown as ActivityService;

const mockAuthService = {
  ensureLeagueMember: jest.fn().mockResolvedValue({ id: 1, leagueId: 1, userId: 'user-1' }),
} as unknown as AuthorizationService;

const mockRosterRepo = {
  findById: jest.fn().mockResolvedValue({ id: 10, leagueId: 1, userId: 'user-1' }),
} as unknown as RosterRepository;

const controller = new ActivityController(mockActivityService, mockAuthService, mockRosterRepo);

function mockReq(overrides: Partial<AuthRequest> = {}): AuthRequest {
  return {
    user: { userId: 'user-1', username: 'testuser' },
    params: {},
    query: {},
    ...overrides,
  } as unknown as AuthRequest;
}

function mockRes(): Response {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res as Response;
}

beforeEach(() => jest.clearAllMocks());

describe('ActivityController authorization', () => {
  describe('getLeagueActivity', () => {
    it('throws ForbiddenException when user is not a league member', async () => {
      (mockAuthService.ensureLeagueMember as jest.Mock).mockRejectedValueOnce(
        new ForbiddenException('You are not a member of this league')
      );
      const req = mockReq({ params: { leagueId: '1' } } as any);
      const res = mockRes();

      await expect(controller.getLeagueActivity(req, res)).rejects.toThrow(ForbiddenException);

      expect(mockActivityService.getLeagueActivity).not.toHaveBeenCalled();
    });

    it('returns activity when user is a league member', async () => {
      const activities = [{ id: 'trade:1', type: 'trade' }];
      (mockActivityService.getLeagueActivity as jest.Mock).mockResolvedValueOnce(activities);

      const req = mockReq({ params: { leagueId: '1' } } as any);
      const res = mockRes();

      await controller.getLeagueActivity(req, res);

      expect(mockAuthService.ensureLeagueMember).toHaveBeenCalledWith(1, 'user-1');
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(activities);
    });
  });

  describe('getWeekActivity', () => {
    it('throws ForbiddenException when user is not a league member', async () => {
      (mockAuthService.ensureLeagueMember as jest.Mock).mockRejectedValueOnce(
        new ForbiddenException('You are not a member of this league')
      );
      const req = mockReq({ params: { leagueId: '1', week: '3' } } as any);
      const res = mockRes();

      await expect(controller.getWeekActivity(req, res)).rejects.toThrow(ForbiddenException);

      expect(mockActivityService.getLeagueActivity).not.toHaveBeenCalled();
    });
  });

  describe('getRosterActivity', () => {
    it('throws ForbiddenException when roster does not exist (no info leak)', async () => {
      (mockRosterRepo.findById as jest.Mock).mockResolvedValueOnce(null);

      const req = mockReq({ params: { rosterId: '999' } } as any);
      const res = mockRes();

      await expect(controller.getRosterActivity(req, res)).rejects.toThrow(ForbiddenException);

      expect(mockAuthService.ensureLeagueMember).not.toHaveBeenCalled();
    });

    it('throws ForbiddenException when user is not in the roster league', async () => {
      (mockRosterRepo.findById as jest.Mock).mockResolvedValueOnce({ id: 10, leagueId: 5 });
      (mockAuthService.ensureLeagueMember as jest.Mock).mockRejectedValueOnce(
        new ForbiddenException('You are not a member of this league')
      );

      const req = mockReq({ params: { rosterId: '10' } } as any);
      const res = mockRes();

      await expect(controller.getRosterActivity(req, res)).rejects.toThrow(ForbiddenException);

      expect(mockAuthService.ensureLeagueMember).toHaveBeenCalledWith(5, 'user-1');
      expect(mockActivityService.getRosterActivity).not.toHaveBeenCalled();
    });

    it('returns activity when user is in the roster league', async () => {
      (mockRosterRepo.findById as jest.Mock).mockResolvedValueOnce({ id: 10, leagueId: 1 });
      (mockActivityService.getRosterActivity as jest.Mock).mockResolvedValueOnce([]);

      const req = mockReq({ params: { rosterId: '10' } } as any);
      const res = mockRes();

      await controller.getRosterActivity(req, res);

      expect(mockAuthService.ensureLeagueMember).toHaveBeenCalledWith(1, 'user-1');
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith([]);
    });

    it('returns 400 for invalid rosterId', async () => {
      const req = mockReq({ params: { rosterId: 'abc' } } as any);
      const res = mockRes();

      await controller.getRosterActivity(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(mockRosterRepo.findById).not.toHaveBeenCalled();
    });
  });
});
