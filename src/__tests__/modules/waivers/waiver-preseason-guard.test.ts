import { Pool, PoolClient } from 'pg';
import { submitClaim, SubmitClaimContext } from '../../../modules/waivers/use-cases/submit-claim.use-case';
import {
  updateClaim,
  reorderClaims,
  cancelClaim,
  ManageClaimContext,
} from '../../../modules/waivers/use-cases/manage-claim.use-case';
import { WaiverClaimsRepository } from '../../../modules/waivers/waiver-claims.repository';
import { RosterPlayersRepository } from '../../../modules/rosters/rosters.repository';
import { LeagueRepository, RosterRepository } from '../../../modules/leagues/leagues.repository';
import { ValidationException } from '../../../utils/exceptions';

// Mock transaction runner
const mockClient = { query: jest.fn() } as unknown as PoolClient;
jest.mock('../../../shared/transaction-runner', () => ({
  runWithLock: jest.fn(async (_pool: any, _domain: any, _id: any, fn: any) => {
    return fn(mockClient);
  }),
  LockDomain: { WAIVER: 'WAIVER' },
}));

// Mock events
jest.mock('../../../shared/events', () => ({
  tryGetEventBus: jest.fn(() => ({
    publish: jest.fn(),
  })),
  EventTypes: {
    WAIVER_CLAIMED: 'WAIVER_CLAIMED',
    WAIVER_CLAIM_UPDATED: 'WAIVER_CLAIM_UPDATED',
    WAIVER_CLAIMS_REORDERED: 'WAIVER_CLAIMS_REORDERED',
    WAIVER_CLAIM_CANCELLED: 'WAIVER_CLAIM_CANCELLED',
  },
}));

jest.mock('../../../config/logger.config', () => ({
  logger: { warn: jest.fn(), info: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

const PRESEASON_MESSAGE = "Waivers aren't available until the season starts (Week 1).";

describe('Preseason waiver guards', () => {
  const preseasonLeague = {
    id: 1,
    season: '2024',
    currentWeek: null,
    settings: {
      waiver_type: 'standard',
      waiver_day: 2,
      waiver_hour: 3,
      roster_size: 15,
      // No current_week in settings either
    },
    activeLeagueSeasonId: 100,
  };

  describe('submitClaim', () => {
    it('should reject claim submission during preseason', async () => {
      const ctx: SubmitClaimContext = {
        db: {} as Pool,
        priorityRepo: {} as any,
        faabRepo: {} as any,
        claimsRepo: {} as any,
        rosterRepo: {
          findByLeagueAndUser: jest.fn().mockResolvedValue({ id: 101, userId: 'user1' }),
        } as unknown as jest.Mocked<RosterRepository>,
        rosterPlayersRepo: {} as any,
        leagueRepo: {
          findById: jest.fn().mockResolvedValue(preseasonLeague),
        } as unknown as jest.Mocked<LeagueRepository>,
      };

      await expect(
        submitClaim(ctx, 1, 'user1', { playerId: 1001 })
      ).rejects.toThrow(ValidationException);

      await expect(
        submitClaim(ctx, 1, 'user1', { playerId: 1001 })
      ).rejects.toThrow(PRESEASON_MESSAGE);
    });
  });

  describe('updateClaim', () => {
    it('should reject claim update during preseason', async () => {
      const ctx: ManageClaimContext = {
        db: {} as Pool,
        faabRepo: {} as any,
        claimsRepo: {
          findById: jest.fn().mockResolvedValue({
            id: 1,
            rosterId: 101,
            leagueId: 1,
            status: 'pending',
          }),
        } as unknown as jest.Mocked<WaiverClaimsRepository>,
        rosterRepo: {
          findById: jest.fn().mockResolvedValue({ id: 101, userId: 'user1' }),
        } as unknown as jest.Mocked<RosterRepository>,
        rosterPlayersRepo: {} as any,
        leagueRepo: {
          findById: jest.fn().mockResolvedValue(preseasonLeague),
        } as unknown as jest.Mocked<LeagueRepository>,
      };

      await expect(
        updateClaim(ctx, 1, 'user1', { bidAmount: 50 })
      ).rejects.toThrow(ValidationException);

      await expect(
        updateClaim(ctx, 1, 'user1', { bidAmount: 50 })
      ).rejects.toThrow(PRESEASON_MESSAGE);
    });
  });

  describe('reorderClaims', () => {
    it('should reject claim reorder during preseason', async () => {
      const ctx: ManageClaimContext = {
        db: {} as Pool,
        faabRepo: {} as any,
        claimsRepo: {} as any,
        rosterRepo: {
          findByLeagueAndUser: jest.fn().mockResolvedValue({ id: 101, userId: 'user1' }),
        } as unknown as jest.Mocked<RosterRepository>,
        rosterPlayersRepo: {} as any,
        leagueRepo: {
          findById: jest.fn().mockResolvedValue(preseasonLeague),
        } as unknown as jest.Mocked<LeagueRepository>,
      };

      await expect(
        reorderClaims(ctx, 1, 'user1', [1, 2, 3])
      ).rejects.toThrow(ValidationException);

      await expect(
        reorderClaims(ctx, 1, 'user1', [1, 2, 3])
      ).rejects.toThrow(PRESEASON_MESSAGE);
    });
  });

  describe('cancelClaim', () => {
    it('should NOT reject claim cancellation during preseason', async () => {
      const mockCancelIfPending = jest.fn().mockResolvedValue(true);
      const ctx: ManageClaimContext = {
        db: {} as Pool,
        faabRepo: {} as any,
        claimsRepo: {
          findById: jest.fn().mockResolvedValue({
            id: 1,
            rosterId: 101,
            leagueId: 1,
            status: 'pending',
          }),
          cancelIfPending: mockCancelIfPending,
        } as unknown as jest.Mocked<WaiverClaimsRepository>,
        rosterRepo: {
          findById: jest.fn().mockResolvedValue({ id: 101, userId: 'user1' }),
        } as unknown as jest.Mocked<RosterRepository>,
        rosterPlayersRepo: {} as any,
        leagueRepo: {
          findById: jest.fn().mockResolvedValue(preseasonLeague),
        } as unknown as jest.Mocked<LeagueRepository>,
      };

      // cancelClaim should succeed even during preseason
      await expect(
        cancelClaim(ctx, 1, 'user1')
      ).resolves.not.toThrow();

      expect(mockCancelIfPending).toHaveBeenCalledWith(1, expect.anything());
    });
  });
});
