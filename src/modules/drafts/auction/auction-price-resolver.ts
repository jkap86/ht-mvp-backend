import { PoolClient } from 'pg';
import { AuctionLot, AuctionProxyBid, auctionLotFromDatabase } from './auction.models';
import { ValidationException } from '../../../utils/exceptions';
import {
  resolveSecondPrice,
  type PriceResolutionInput,
} from '../../../domain/auction/pricing';

// Re-export domain types for backward compatibility
export type { OutbidNotification } from '../../../domain/auction/pricing';

/**
 * Result of price resolution
 */
export interface PriceResolutionResult {
  updatedLot: AuctionLot;
  outbidNotifications: Array<{
    rosterId: number;
    lotId: number;
    previousBid: number;
    newLeadingBid: number;
  }>;
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
 * Orchestrates: fetch proxy bids → call domain pricing → CAS update → record history.
 * The pure pricing logic lives in domain/auction/pricing.ts.
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
     ORDER BY max_bid DESC, created_at ASC`,
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

  // Call pure domain function for price resolution
  const input: PriceResolutionInput = {
    lotId: lot.id,
    currentBid: lot.currentBid,
    currentBidderRosterId: lot.currentBidderRosterId,
    proxyBids: proxyBids.map((pb) => ({ rosterId: pb.rosterId, maxBid: pb.maxBid })),
    minBid: settings.minBid,
    minIncrement: settings.minIncrement,
  };

  const resolution = resolveSecondPrice(input, lot.bidCount);

  // No bids — nothing to resolve
  if (!resolution) {
    return { updatedLot: lot, outbidNotifications: [], leaderChanged: false, priceChanged: false };
  }

  const { newLeader, newPrice, leaderChanged, priceChanged, newBidCount, outbidNotifications } = resolution;

  let updatedLot = lot;

  // Update if anything changed
  if (leaderChanged || priceChanged) {
    // Use provided deadline or keep existing
    const deadline = newBidDeadline ?? lot.bidDeadline;

    // CAS-style update: Only update if lot state matches expected values
    const updateResult = await client.query(
      `UPDATE auction_lots
       SET current_bidder_roster_id = $2, current_bid = $3, bid_count = $4, bid_deadline = $5, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND current_bid = $6 AND current_bidder_roster_id IS NOT DISTINCT FROM $7 AND status = 'active'
       RETURNING *`,
      [lot.id, newLeader, newPrice, newBidCount, deadline, lot.currentBid, lot.currentBidderRosterId]
    );

    // If no rows updated, the lot state changed between our read and write
    if (updateResult.rowCount === 0) {
      throw new ValidationException('Another bid was placed simultaneously — please try again');
    }

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
