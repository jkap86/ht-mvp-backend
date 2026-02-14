import {
  submitClaim,
  SubmitClaimContext,
} from '../../../modules/waivers/use-cases/submit-claim.use-case';

// Mock dependencies
jest.mock('../../../shared/events', () => ({
  tryGetEventBus: jest.fn(() => ({ publish: jest.fn() })),
  EventTypes: {},
}));

// Mock runWithLock to execute callback immediately
jest.mock('../../../shared/transaction-runner', () => ({
  runWithLock: jest.fn(async (db, domain, id, callback) => callback(db)),
  LockDomain: { WAIVER: 'waiver' },
}));

describe('Submit Claim Idempotency', () => {
  let mockCtx: SubmitClaimContext;

  beforeEach(() => {
    mockCtx = {
      db: {} as any,
      leagueRepo: { findById: jest.fn() } as any,
      claimsRepo: {
        findByIdempotencyKey: jest.fn(),
        create: jest.fn(),
        findByIdWithDetails: jest.fn(),
        hasPendingClaim: jest.fn().mockResolvedValue(false),
        getNextClaimOrder: jest.fn().mockResolvedValue(1),
      } as any,
      rosterRepo: { findByLeagueAndUser: jest.fn() } as any,
      rosterPlayersRepo: { findOwner: jest.fn().mockResolvedValue(null) } as any,
      priorityRepo: {
        getByRoster: jest.fn().mockResolvedValue({ priority: 1 }),
        ensureRosterPriority: jest.fn(),
      } as any,
      faabRepo: { getByRoster: jest.fn() } as any,
    };

    (mockCtx.rosterRepo.findByLeagueAndUser as jest.Mock).mockResolvedValue({ id: 1 });
    (mockCtx.leagueRepo.findById as jest.Mock).mockResolvedValue({
      id: 1,
      season: '2024',
      settings: { waiver_type: 'faab', current_week: 1 },
    });
    (mockCtx.faabRepo.getByRoster as jest.Mock).mockResolvedValue({ remainingBudget: 100 });
  });

  test('Idempotency: Duplicate key returns existing claim without creating new one', async () => {
    const idempotencyKey = 'uuid-123';
    const existingClaim = { id: 99, status: 'pending' };

    // First check (outside lock) returns null
    // Second check (inside lock) returns existing claim (simulating race condition)
    (mockCtx.claimsRepo.findByIdempotencyKey as jest.Mock)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(existingClaim);

    // Fix: Mock findByIdWithDetails to return the claim, otherwise use case throws "Failed to get claim details"
    (mockCtx.claimsRepo.findByIdWithDetails as jest.Mock).mockResolvedValue(existingClaim);

    const result = await submitClaim(
      mockCtx,
      1,
      'user-1',
      { playerId: 10, bidAmount: 5 },
      idempotencyKey
    );

    expect(result).toEqual(existingClaim);
    expect(mockCtx.claimsRepo.create).not.toHaveBeenCalled();
  });

  test('Idempotency: New key creates claim', async () => {
    const idempotencyKey = 'uuid-new';
    const newClaim = { id: 100, status: 'pending' };

    // Both checks return null (no existing claim)
    (mockCtx.claimsRepo.findByIdempotencyKey as jest.Mock).mockResolvedValue(null);
    (mockCtx.claimsRepo.create as jest.Mock).mockResolvedValue(newClaim);
    (mockCtx.claimsRepo.findByIdWithDetails as jest.Mock).mockResolvedValue(newClaim);

    await submitClaim(mockCtx, 1, 'user-1', { playerId: 10, bidAmount: 5 }, idempotencyKey);

    expect(mockCtx.claimsRepo.create).toHaveBeenCalled();
  });
});
