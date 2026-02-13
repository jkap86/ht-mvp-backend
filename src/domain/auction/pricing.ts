/**
 * Auction Price Resolution Domain Logic
 *
 * Pure functions for second-price sealed-bid proxy auction algorithm.
 * No async I/O, no database access.
 */

export interface ProxyBidSnapshot {
  rosterId: number;
  maxBid: number;
}

export interface OutbidNotification {
  rosterId: number;
  lotId: number;
  previousBid: number;
  newLeadingBid: number;
}

export interface PriceResolutionInput {
  lotId: number;
  currentBid: number;
  currentBidderRosterId: number | null;
  proxyBids: ProxyBidSnapshot[];
  minBid: number;
  minIncrement: number;
}

export interface PriceResolutionOutput {
  newLeader: number;
  newPrice: number;
  leaderChanged: boolean;
  priceChanged: boolean;
  newBidCount: number;
  outbidNotifications: OutbidNotification[];
}

/**
 * Resolve auction price using second-price sealed-bid rules with proxy bids.
 *
 * Algorithm:
 * - Highest bidder wins at second-highest price + minIncrement
 * - If only one bidder, price is max(currentBid, minBid)
 * - Monotonic guard: resolved price never decreases below currentBid
 * - Leader is whoever has the highest maxBid (ties broken by earliest bid — caller must sort)
 *
 * @param input - Current lot state and sorted proxy bids (highest maxBid first, then earliest)
 * @param currentBidCount - Current bid_count on the lot
 * @returns Resolved price, leader, and outbid notifications. Returns null if no bids.
 */
export function resolveSecondPrice(
  input: PriceResolutionInput,
  currentBidCount: number
): PriceResolutionOutput | null {
  const { proxyBids, currentBid, currentBidderRosterId, lotId, minBid, minIncrement } = input;

  if (proxyBids.length === 0) {
    return null;
  }

  const previousLeader = currentBidderRosterId;
  let newLeader: number;
  let newPrice: number;

  if (proxyBids.length === 1) {
    // Single bidder: wins at the higher of currentBid or minBid.
    // In fast auction, currentBid is set to the opening bid at nomination,
    // so this prevents price from regressing below the opening bid.
    newLeader = proxyBids[0].rosterId;
    newPrice = Math.max(currentBid ?? minBid, minBid);
  } else {
    // Multiple bidders: highest wins at second-highest + increment
    const highest = proxyBids[0];
    const secondHighest = proxyBids[1];
    newLeader = highest.rosterId;
    newPrice = Math.min(highest.maxBid, secondHighest.maxBid + minIncrement);
  }

  // Monotonic guard: resolved price must never decrease below currentBid
  newPrice = Math.max(newPrice, currentBid ?? 0);

  const leaderChanged = newLeader !== previousLeader;
  const priceChanged = newPrice !== currentBid;

  const outbidNotifications: OutbidNotification[] = [];
  if (leaderChanged && previousLeader) {
    outbidNotifications.push({
      rosterId: previousLeader,
      lotId,
      previousBid: currentBid,
      newLeadingBid: newPrice,
    });
  }

  // bid_count tracks price changes only (not just leader changes)
  const newBidCount = priceChanged ? currentBidCount + 1 : currentBidCount;

  return {
    newLeader,
    newPrice,
    leaderChanged,
    priceChanged,
    newBidCount,
    outbidNotifications,
  };
}
