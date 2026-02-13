import { PoolClient } from 'pg';

/**
 * Budget data for a roster in an auction draft.
 * Re-exported as alias for backward compatibility.
 */
export type { RosterBudgetSnapshot as RosterBudgetData } from '../../../domain/auction/budget';

// Re-export pure domain functions for backward compatibility
export { calculateMaxAffordableBid, canAffordMinBid } from '../../../domain/auction/budget';

// Re-export the snapshot type under its canonical name too
export type { RosterBudgetSnapshot } from '../../../domain/auction/budget';

/**
 * Get roster budget data within a database transaction.
 * This is the DB-access function that stays in the module layer.
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
): Promise<{ spent: number; wonCount: number; leadingCommitment: number }> {
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
