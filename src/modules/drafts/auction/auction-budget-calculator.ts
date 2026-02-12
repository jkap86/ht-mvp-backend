import { PoolClient } from 'pg';

/**
 * Budget data for a roster in an auction draft
 */
export interface RosterBudgetData {
  spent: number;
  wonCount: number;
  leadingCommitment: number;
}

/**
 * Get roster budget data within a database transaction
 *
 * @param client - PostgreSQL client for transaction
 * @param draftId - Draft ID
 * @param rosterId - Roster ID
 * @returns Budget data including spent amount, won count, and leading commitments
 */
export async function getRosterBudgetDataWithClient(
  client: PoolClient,
  draftId: number,
  rosterId: number
): Promise<RosterBudgetData> {
  const wonResult = await client.query(
    `SELECT COALESCE(SUM(winning_bid), 0) as spent, COUNT(*) as won_count
     FROM auction_lots
     WHERE draft_id = $1 AND winning_roster_id = $2 AND status = 'won'`,
    [draftId, rosterId]
  );
  const leadingResult = await client.query(
    `SELECT COALESCE(SUM(current_bid), 0) as leading_commitment
     FROM auction_lots
     WHERE draft_id = $1 AND current_bidder_roster_id = $2 AND status = 'active'`,
    [draftId, rosterId]
  );
  return {
    spent: Number(wonResult.rows[0].spent) || 0,
    wonCount: Number(wonResult.rows[0].won_count) || 0,
    leadingCommitment: Number(leadingResult.rows[0].leading_commitment) || 0,
  };
}

/**
 * Calculate the maximum affordable bid for a roster
 *
 * @param totalBudget - Total budget for the roster
 * @param rosterSlots - Number of roster slots
 * @param budgetData - Current budget data
 * @param currentLotBid - Current bid on the lot (if roster is leading)
 * @param isLeadingCurrentLot - Whether this roster is currently leading the lot
 * @param minBid - Minimum bid required per slot
 * @returns Maximum affordable bid amount
 */
export function calculateMaxAffordableBid(
  totalBudget: number,
  rosterSlots: number,
  budgetData: RosterBudgetData,
  currentLotBid: number,
  isLeadingCurrentLot: boolean,
  minBid: number
): number {
  const remainingSlots = rosterSlots - budgetData.wonCount - 1; // -1 for current lot
  const reservedForMinBids = Math.max(0, remainingSlots) * minBid;

  let maxAffordable =
    totalBudget - budgetData.spent - reservedForMinBids - budgetData.leadingCommitment;

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
 * @param totalBudget - Total budget for the roster
 * @param rosterSlots - Number of roster slots
 * @param budgetData - Current budget data
 * @param minBid - Minimum bid required per slot
 * @returns Whether the roster can afford to nominate at minBid
 */
export function canAffordMinBid(
  totalBudget: number,
  rosterSlots: number,
  budgetData: RosterBudgetData,
  minBid: number
): boolean {
  const remainingSlots = rosterSlots - budgetData.wonCount - 1;
  const reservedForMinBids = Math.max(0, remainingSlots) * minBid;
  const maxAffordable = totalBudget - budgetData.spent - reservedForMinBids - budgetData.leadingCommitment;
  return minBid <= maxAffordable;
}
