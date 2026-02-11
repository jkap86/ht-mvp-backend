import { PoolClient } from 'pg';
import { resolvePriceWithClient, PriceResolutionSettings } from '../../../modules/drafts/auction/auction-price-resolver';
import { AuctionLot } from '../../../modules/drafts/auction/auction.models';

// Helper to build a mock lot
function makeLot(overrides: Partial<AuctionLot> = {}): AuctionLot {
  return {
    id: 1,
    draftId: 1,
    playerId: 100,
    nominatorRosterId: 1,
    currentBid: 1,
    currentBidderRosterId: null,
    bidCount: 0,
    bidDeadline: new Date(Date.now() + 60000),
    status: 'active',
    winningRosterId: null,
    winningBid: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

// Helper to build a mock PoolClient that returns proxy bids and handles the CAS update
function makeMockClient(proxyBids: Array<{ roster_id: number; max_bid: number; created_at?: Date }>): PoolClient {
  const now = new Date();
  const rows = proxyBids.map((pb, i) => ({
    id: i + 1,
    lot_id: 1,
    roster_id: pb.roster_id,
    max_bid: pb.max_bid,
    created_at: pb.created_at ?? new Date(now.getTime() + i * 1000),
    updated_at: new Date(),
  }));

  const client = {
    query: jest.fn().mockImplementation((_sql: string, _params?: any[]) => {
      const sql = _sql.trim();
      if (sql.startsWith('SELECT * FROM auction_proxy_bids')) {
        return { rows };
      }
      if (sql.startsWith('UPDATE auction_lots')) {
        // Simulate a successful CAS update by returning a row
        const updatedRow = {
          id: 1,
          draft_id: 1,
          player_id: 100,
          nominator_roster_id: 1,
          current_bid: _params?.[2] ?? 1,
          current_bidder_roster_id: _params?.[1] ?? null,
          bid_count: _params?.[3] ?? 0,
          bid_deadline: _params?.[4] ?? new Date(),
          status: 'active',
          winning_roster_id: null,
          winning_bid: null,
          created_at: new Date(),
          updated_at: new Date(),
        };
        return { rows: [updatedRow], rowCount: 1 };
      }
      if (sql.startsWith('INSERT INTO auction_bid_history')) {
        return { rows: [], rowCount: 1 };
      }
      return { rows: [] };
    }),
  } as unknown as PoolClient;

  return client;
}

describe('resolvePriceWithClient', () => {
  const defaultSettings: PriceResolutionSettings = {
    minBid: 1,
    minIncrement: 1,
  };

  it('single-bidder uses currentBid as floor (not minBid)', async () => {
    // In fast auction, lot.currentBid is set to the opening bid (e.g. 5)
    // With only one bidder, price should be max(5, 1) = 5, not just minBid=1
    const lot = makeLot({ currentBid: 5, currentBidderRosterId: 10 });
    const client = makeMockClient([{ roster_id: 10, max_bid: 5 }]);

    const result = await resolvePriceWithClient(client, lot, defaultSettings);

    // Price should be 5 (the currentBid), not 1 (minBid)
    expect(result.updatedLot.currentBid).toBe(5);
    expect(result.priceChanged).toBe(false); // currentBid was already 5
  });

  it('monotonic guard prevents price regression below currentBid', async () => {
    // Scenario: lot.currentBid=20, two bids [25, 15]
    // Normal second-price: min(25, 15+1) = 16
    // Monotonic guard: max(16, 20) = 20 (prevents regression)
    const lot = makeLot({ currentBid: 20, currentBidderRosterId: 10 });
    const client = makeMockClient([
      { roster_id: 10, max_bid: 25 },
      { roster_id: 20, max_bid: 15 },
    ]);

    const result = await resolvePriceWithClient(client, lot, defaultSettings);

    // Price should stay at 20 (monotonic guard), not drop to 16
    expect(result.updatedLot.currentBid).toBe(20);
    expect(result.priceChanged).toBe(false); // 20 === 20
  });

  it('normal multi-bidder case is unaffected', async () => {
    // lot.currentBid=10, two bids [50, 30]
    // Second-price: min(50, 30+1) = 31
    // Monotonic guard: max(31, 10) = 31 (no-op)
    const lot = makeLot({ currentBid: 10, currentBidderRosterId: 20 });
    const client = makeMockClient([
      { roster_id: 10, max_bid: 50 },
      { roster_id: 20, max_bid: 30 },
    ]);

    const result = await resolvePriceWithClient(client, lot, defaultSettings);

    expect(result.updatedLot.currentBid).toBe(31);
    expect(result.leaderChanged).toBe(true); // Leader changed from 20 to 10
    expect(result.priceChanged).toBe(true); // 31 !== 10
  });
});
