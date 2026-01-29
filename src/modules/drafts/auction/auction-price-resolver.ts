import { PoolClient } from 'pg';
import { AuctionLot, AuctionProxyBid, auctionLotFromDatabase } from './auction.models';

/**
 * Notification when a bidder is outbid
 */
export interface OutbidNotification {
  rosterId: number;
  lotId: number;
  previousBid: number;
  newLeadingBid: number;
}

/**
 * Result of price resolution
 */
export interface PriceResolutionResult {
  updatedLot: AuctionLot;
  outbidNotifications: OutbidNotification[];
  leaderChanged: boolean;
  priceChanged: boolean;
}

/**
 * Settings required for price resolution
 */
export interface PriceResolutionSettings {
  minBid: number;
  minIncrement: number;
}

/**
 * Resolve auction price using second-price sealed-bid rules with proxy bids.
 *
 * Algorithm:
 * - Highest bidder wins at second-highest price + minIncrement
 * - If only one bidder, price is minBid
 * - Leader is whoever has the highest maxBid (ties broken by earliest bid)
 *
 * This function does NOT handle timer resets - that is mode-specific
 * and should be handled by the caller (slow auction resets on leader change,
 * fast auction resets on any price/leader change).
 *
 * @param client - PostgreSQL client for transaction
 * @param lot - Current lot state
 * @param settings - minBid and minIncrement values
 * @param newBidDeadline - Optional new deadline to set (for slow auction timer reset)
 * @returns Updated lot and outbid notifications
 */
export async function resolvePriceWithClient(
  client: PoolClient,
  lot: AuctionLot,
  settings: PriceResolutionSettings,
  newBidDeadline?: Date
): Promise<PriceResolutionResult> {
  // Fetch all proxy bids ordered by max_bid DESC, then by earliest submission
  const proxyBidsResult = await client.query(
    `SELECT * FROM auction_proxy_bids
     WHERE lot_id = $1
     ORDER BY max_bid DESC, updated_at ASC`,
    [lot.id]
  );
  const proxyBids: AuctionProxyBid[] = proxyBidsResult.rows.map((row) => ({
    id: row.id,
    lotId: row.lot_id,
    rosterId: row.roster_id,
    maxBid: row.max_bid,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));

  const outbidNotifications: OutbidNotification[] = [];
  let updatedLot = lot;
  let leaderChanged = false;
  let priceChanged = false;

  // No bids - nothing to resolve
  if (proxyBids.length === 0) {
    return { updatedLot, outbidNotifications, leaderChanged, priceChanged };
  }

  const previousLeader = lot.currentBidderRosterId;
  let newLeader: number;
  let newPrice: number;

  if (proxyBids.length === 1) {
    // Single bidder: wins at minBid
    newLeader = proxyBids[0].rosterId;
    newPrice = settings.minBid;
  } else {
    // Multiple bidders: highest wins at second-highest + increment
    const highest = proxyBids[0];
    const secondHighest = proxyBids[1];
    newLeader = highest.rosterId;
    newPrice = Math.min(highest.maxBid, secondHighest.maxBid + settings.minIncrement);
  }

  leaderChanged = newLeader !== previousLeader;
  priceChanged = newPrice !== lot.currentBid;

  // Update if anything changed
  if (leaderChanged || priceChanged) {
    // Generate outbid notification for previous leader
    if (leaderChanged && previousLeader) {
      outbidNotifications.push({
        rosterId: previousLeader,
        lotId: lot.id,
        previousBid: lot.currentBid,
        newLeadingBid: newPrice,
      });
    }

    // bid_count tracks price changes only (not just leader changes)
    const newBidCount = priceChanged ? lot.bidCount + 1 : lot.bidCount;

    // Use provided deadline or keep existing
    const deadline = newBidDeadline ?? lot.bidDeadline;

    const updateResult = await client.query(
      `UPDATE auction_lots
       SET current_bidder_roster_id = $2, current_bid = $3, bid_count = $4, bid_deadline = $5, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING *`,
      [lot.id, newLeader, newPrice, newBidCount, deadline]
    );
    updatedLot = auctionLotFromDatabase(updateResult.rows[0]);

    // Record bid history
    await client.query(
      `INSERT INTO auction_bid_history (lot_id, roster_id, bid_amount, is_proxy)
       VALUES ($1, $2, $3, $4)`,
      [lot.id, newLeader, newPrice, true]
    );
  }

  return { updatedLot, outbidNotifications, leaderChanged, priceChanged };
}
