/**
 * Auction Budget Domain Logic
 *
 * Pure functions for auction budget calculations.
 * No async I/O, no database access.
 */

/**
 * Budget snapshot for a roster in an auction draft.
 * Passed in from the repository layer — domain never queries DB.
 */
export interface RosterBudgetSnapshot {
  spent: number;
  wonCount: number;
  leadingCommitment: number;
}

/**
 * Calculate the maximum affordable bid for a roster on a specific lot.
 *
 * Formula: totalBudget - spent - reservedForMinBids - leadingCommitment + reusableCommitment
 * where reservedForMinBids = max(0, remainingSlots) * minBid
 * and reusableCommitment = currentLotBid if the roster is already leading this lot
 *
 * @param totalBudget - Total auction budget for the roster
 * @param rosterSlots - Number of roster slots to fill
 * @param snapshot - Current budget state from DB
 * @param currentLotBid - Current bid on the lot being bid on
 * @param isLeadingCurrentLot - Whether this roster is currently leading the lot
 * @param minBid - Minimum bid required per slot
 * @returns Maximum affordable bid amount
 */
export function calculateMaxAffordableBid(
  totalBudget: number,
  rosterSlots: number,
  snapshot: RosterBudgetSnapshot,
  currentLotBid: number,
  isLeadingCurrentLot: boolean,
  minBid: number
): number {
  const remainingSlots = rosterSlots - snapshot.wonCount - 1; // -1 for current lot
  const reservedForMinBids = Math.max(0, remainingSlots) * minBid;

  let maxAffordable =
    totalBudget - snapshot.spent - reservedForMinBids - snapshot.leadingCommitment;

  // If leading the current lot, can reuse that commitment
  if (isLeadingCurrentLot) {
    maxAffordable += currentLotBid;
  }

  return maxAffordable;
}

/**
 * Check if a roster can afford the minimum bid for a new nomination.
 * Used for nominator eligibility checks where there is no active lot context.
 *
 * @param totalBudget - Total auction budget for the roster
 * @param rosterSlots - Number of roster slots to fill
 * @param snapshot - Current budget state from DB
 * @param minBid - Minimum bid required per slot
 * @returns Whether the roster can afford to nominate at minBid
 */
export function canAffordMinBid(
  totalBudget: number,
  rosterSlots: number,
  snapshot: RosterBudgetSnapshot,
  minBid: number
): boolean {
  const remainingSlots = rosterSlots - snapshot.wonCount - 1;
  const reservedForMinBids = Math.max(0, remainingSlots) * minBid;
  const maxAffordable = totalBudget - snapshot.spent - reservedForMinBids - snapshot.leadingCommitment;
  return minBid <= maxAffordable;
}

/**
 * Compute the available budget for a roster (for display/reporting purposes).
 *
 * Formula: totalBudget - spent - reservedForMinBids - leadingCommitment
 * where reservedForMinBids = max(0, remainingSlots - 1) * minBid
 *
 * Note: Uses remainingSlots - 1 (not remainingSlots) because the formula assumes
 * one slot is "current" and doesn't need a minBid reserve.
 *
 * @param totalBudget - Total auction budget
 * @param rosterSlots - Number of roster slots to fill
 * @param snapshot - Current budget state from DB
 * @param minBid - Minimum bid per slot
 * @returns Available budget (clamped to 0 minimum)
 */
export function computeAvailableBudget(
  totalBudget: number,
  rosterSlots: number,
  snapshot: RosterBudgetSnapshot,
  minBid: number
): number {
  const remainingSlots = rosterSlots - snapshot.wonCount;
  const reservedForMinBids = Math.max(0, remainingSlots - 1) * minBid;
  const available = totalBudget - snapshot.spent - reservedForMinBids - snapshot.leadingCommitment;
  return Math.max(0, available);
}
