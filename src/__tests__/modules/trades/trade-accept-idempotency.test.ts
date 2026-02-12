import { Pool, PoolClient } from 'pg';
import { acceptTrade, AcceptTradeContext } from '../../../modules/trades/use-cases/accept-trade.use-case';
import { TradesRepository, TradeItemsRepository } from '../../../modules/trades/trades.repository';
import {
  RosterPlayersRepository,
  RosterTransactionsRepository,
} from '../../../modules/rosters/rosters.repository';
import { RosterMutationService } from '../../../modules/rosters/roster-mutation.service';
import { LeagueRepository, RosterRepository } from '../../../modules/leagues/leagues.repository';
import { Trade, TradeWithDetails } from '../../../modules/trades/trades.model';
import { ValidationException } from '../../../utils/exceptions';

// Mock transaction runner to execute callback directly
jest.mock('../../../shared/transaction-runner', () => ({
  runWithLock: jest.fn(async (_pool: any, _domain: any, _id: any, fn: any) => {
    const mockClient = { query: jest.fn() } as unknown as PoolClient;
    return fn(mockClient);
  }),
  runWithLocks: jest.fn(async (_pool: any, _locks: any, fn: any) => {
    const mockClient = { query: jest.fn() } as unknown as PoolClient;
    return fn(mockClient);
  }),
  LockDomain: { TRADE: 'TRADE', ROSTER: 'ROSTER' },
}));

// Mock events
jest.mock('../../../shared/events', () => ({
  tryGetEventBus: jest.fn(() => ({
    publish: jest.fn(),
  })),
  EventTypes: {
    TRADE_ACCEPTED: 'TRADE_ACCEPTED',
    TRADE_COMPLETED: 'TRADE_COMPLETED',
    PICK_TRADED: 'PICK_TRADED',
  },
}));

jest.mock('../../../config/logger.config', () => ({
  logger: { warn: jest.fn(), info: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

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

describe('acceptTrade — idempotency', () => {
  let ctx: AcceptTradeContext;

  beforeEach(() => {
    ctx = {
      db: {} as Pool,
      tradesRepo: {
        findById: jest.fn(),
        findByIdWithDetails: jest.fn(),
        updateStatus: jest.fn(),
        setReviewPeriod: jest.fn(),
      } as unknown as jest.Mocked<TradesRepository>,
      tradeItemsRepo: {
        findByTrade: jest.fn(),
      } as unknown as jest.Mocked<TradeItemsRepository>,
      rosterRepo: {
        findById: jest.fn(),
      } as unknown as jest.Mocked<RosterRepository>,
      rosterPlayersRepo: {} as jest.Mocked<RosterPlayersRepository>,
      transactionsRepo: {} as jest.Mocked<RosterTransactionsRepository>,
      leagueRepo: {
        findById: jest.fn(),
      } as unknown as jest.Mocked<LeagueRepository>,
      rosterMutationService: {} as jest.Mocked<RosterMutationService>,
    };
  });

  it('should return same result when trade is already accepted (idempotent retry)', async () => {
    const trade = createMockTrade({ status: 'pending' });
    const acceptedTrade = createMockTrade({ status: 'accepted' });
    const details = createMockTradeWithDetails({ status: 'accepted' });

    // First findById (outside lock): returns pending trade
    (ctx.tradesRepo.findById as jest.Mock)
      .mockResolvedValueOnce(trade)
      // Second findById (inside lock): returns already-accepted trade
      .mockResolvedValueOnce(acceptedTrade);

    (ctx.rosterRepo.findById as jest.Mock).mockResolvedValue({
      id: 2,
      userId: 'user-2',
      leagueId: 1,
    });

    (ctx.leagueRepo.findById as jest.Mock).mockResolvedValue({
      id: 1,
      settings: {},
    });

    (ctx.tradesRepo.findByIdWithDetails as jest.Mock).mockResolvedValue(details);

    const result = await acceptTrade(ctx, 1, 'user-2');

    // Should return the existing accepted trade details
    expect(result.status).toBe('accepted');

    // Should NOT have called updateStatus (no duplicate state change)
    expect(ctx.tradesRepo.updateStatus).not.toHaveBeenCalled();
  });

  it('should reject when trade status changed to non-pending during lock wait', async () => {
    const trade = createMockTrade({ status: 'pending' });
    const cancelledTrade = createMockTrade({ status: 'cancelled' });

    // First findById: pending, inside lock: cancelled
    (ctx.tradesRepo.findById as jest.Mock)
      .mockResolvedValueOnce(trade)
      .mockResolvedValueOnce(cancelledTrade);

    (ctx.rosterRepo.findById as jest.Mock).mockResolvedValue({
      id: 2,
      userId: 'user-2',
      leagueId: 1,
    });

    (ctx.leagueRepo.findById as jest.Mock).mockResolvedValue({
      id: 1,
      settings: {},
    });

    await expect(acceptTrade(ctx, 1, 'user-2')).rejects.toThrow('Cannot accept trade with status');

    // Reset mocks for second call
    (ctx.tradesRepo.findById as jest.Mock)
      .mockResolvedValueOnce(trade)
      .mockResolvedValueOnce(cancelledTrade);

    await expect(acceptTrade(ctx, 1, 'user-2')).rejects.toThrow(ValidationException);
  });
});
