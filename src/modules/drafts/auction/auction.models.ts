export interface AuctionLot {
  id: number;
  draftId: number;
  playerId: number;
  nominatorRosterId: number;
  currentBid: number;
  currentBidderRosterId: number | null;
  bidCount: number;
  bidDeadline: Date;
  status: 'pending' | 'active' | 'won' | 'passed';
  winningRosterId: number | null;
  winningBid: number | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AuctionProxyBid {
  id: number;
  lotId: number;
  rosterId: number;
  maxBid: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface AuctionBidHistory {
  id: number;
  lotId: number;
  rosterId: number;
  bidAmount: number;
  isProxy: boolean;
  createdAt: Date;
}

export interface SlowAuctionSettings {
  bidWindowSeconds: number;
  maxActiveNominationsPerTeam: number;
  maxActiveNominationsGlobal?: number;
  dailyNominationLimit?: number;
  minBid: number;
  minIncrement: number;
  auctionMode?: 'slow' | 'fast';
}

/**
 * Helper to convert DB row (snake_case) to AuctionLot (camelCase)
 */
export function auctionLotFromDatabase(row: any): AuctionLot {
  return {
    id: row.id,
    draftId: row.draft_id,
    playerId: row.player_id,
    nominatorRosterId: row.nominator_roster_id,
    currentBid: row.current_bid,
    currentBidderRosterId: row.current_bidder_roster_id,
    bidCount: row.bid_count,
    bidDeadline: row.bid_deadline,
    status: row.status,
    winningRosterId: row.winning_roster_id,
    winningBid: row.winning_bid,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Helper to convert AuctionLot (camelCase) to API response (snake_case)
 * Accepts optional myMaxBid for user-specific lot data
 */
export function auctionLotToResponse(
  lot: AuctionLot & { myMaxBid?: number }
): Record<string, any> {
  const response: Record<string, any> = {
    id: lot.id,
    draft_id: lot.draftId,
    player_id: lot.playerId,
    nominator_roster_id: lot.nominatorRosterId,
    current_bid: lot.currentBid,
    current_bidder_roster_id: lot.currentBidderRosterId,
    bid_count: lot.bidCount,
    bid_deadline: lot.bidDeadline,
    status: lot.status,
    winning_roster_id: lot.winningRosterId,
    winning_bid: lot.winningBid,
    created_at: lot.createdAt,
    updated_at: lot.updatedAt,
  };

  // Include user's max bid if present
  if (lot.myMaxBid !== undefined) {
    response.my_max_bid = lot.myMaxBid;
  }

  return response;
}

/**
 * Helper to convert DB row to AuctionProxyBid
 */
export function auctionProxyBidFromDatabase(row: any): AuctionProxyBid {
  return {
    id: row.id,
    lotId: row.lot_id,
    rosterId: row.roster_id,
    maxBid: row.max_bid,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Helper to convert DB row to AuctionBidHistory
 */
export function auctionBidHistoryFromDatabase(row: any): AuctionBidHistory {
  return {
    id: row.id,
    lotId: row.lot_id,
    rosterId: row.roster_id,
    bidAmount: row.bid_amount,
    isProxy: row.is_proxy,
    createdAt: row.created_at,
  };
}
