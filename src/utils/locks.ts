/**
 * Centralized advisory lock ID management
 *
 * PostgreSQL advisory locks use integer IDs. To prevent collisions between
 * different subsystems, we use namespaced IDs with large offsets.
 *
 * Lock ordering (to prevent deadlocks):
 * 1. Draft locks
 * 2. Waiver locks
 * 3. Trade locks
 * 4. Auction locks
 * 5. Roster locks
 *
 * Usage:
 *   await client.query('SELECT pg_advisory_xact_lock($1)', [getDraftLockId(draftId)]);
 */

export const LockNamespace = {
  DRAFT: 1_000_000,
  WAIVER: 2_000_000,
  TRADE: 3_000_000,
  AUCTION: 4_000_000,
  ROSTER: 5_000_000,
} as const;

/**
 * Get advisory lock ID for draft operations
 * Used for: making picks, undo picks, draft queue cleanup
 */
export function getDraftLockId(draftId: number): number {
  return LockNamespace.DRAFT + draftId;
}

/**
 * Get advisory lock ID for waiver operations
 * Used for: submitting claims, processing waivers, free agent adds
 *
 * Note: Waivers and rosters share this lock to prevent race conditions
 * between free agent adds and waiver claims
 */
export function getWaiverLockId(leagueId: number): number {
  return LockNamespace.WAIVER + leagueId;
}

/**
 * Get advisory lock ID for trade operations
 * Used for: proposing, accepting, rejecting, countering trades
 */
export function getTradeLockId(leagueId: number): number {
  return LockNamespace.TRADE + leagueId;
}

/**
 * Get advisory lock ID for auction lot operations
 * Used for: bidding on auction lots
 */
export function getAuctionLotLockId(lotId: number): number {
  return LockNamespace.AUCTION + lotId;
}

/**
 * Get advisory lock ID for roster-level auction operations
 * Used for: preventing cross-lot race conditions when same user bids on multiple lots
 */
export function getAuctionRosterLockId(rosterId: number): number {
  return LockNamespace.ROSTER + rosterId;
}
