/**
 * Auction Nomination Domain Logic
 *
 * Pure functions for nominator eligibility and timeout dispatch rules.
 * No async I/O, no database access.
 */

import { RosterBudgetSnapshot, canAffordMinBid } from './budget';

export type NominatorEligibilityReason =
  | 'eligible'
  | 'roster_full'
  | 'insufficient_budget';

export interface NominatorEligibility {
  eligible: boolean;
  reason: NominatorEligibilityReason;
}

/**
 * Assess whether a roster is eligible to nominate in a fast auction.
 *
 * Checks:
 * 1. Roster is not full (wonCount < rosterSlots)
 * 2. Roster can afford the minimum bid
 *
 * @param snapshot - Current budget state for the roster
 * @param totalBudget - Total auction budget
 * @param rosterSlots - Number of roster slots
 * @param minBid - Minimum bid per slot
 * @returns Eligibility result with reason
 */
export function assessNominatorEligibility(
  snapshot: RosterBudgetSnapshot,
  totalBudget: number,
  rosterSlots: number,
  minBid: number
): NominatorEligibility {
  if (snapshot.wonCount >= rosterSlots) {
    return { eligible: false, reason: 'roster_full' };
  }

  if (!canAffordMinBid(totalBudget, rosterSlots, snapshot, minBid)) {
    return { eligible: false, reason: 'insufficient_budget' };
  }

  return { eligible: true, reason: 'eligible' };
}

export type FastAuctionTimeoutAction =
  | 'auto_skip_nominator'
  | 'auto_nominate_no_open_bid'
  | 'auto_nominate_and_open_bid';

export type TimeoutResolution =
  | 'create_lot_with_open_bid'
  | 'create_lot_no_open_bid'
  | 'skip';

/**
 * Resolve what action to take when a nominator times out.
 *
 * Rules:
 * - auto_skip_nominator → always skip (advance to next nominator)
 * - auto_nominate_no_open_bid → create lot without opening bid (if eligible player exists and nominator is eligible)
 * - auto_nominate_and_open_bid → create lot with opening bid (if eligible player exists and nominator is eligible)
 * - If no eligible players exist or nominator is ineligible → skip
 *
 * @param action - The configured timeout action for this draft
 * @param hasEligiblePlayer - Whether any eligible player exists for nomination
 * @param eligibility - Nominator's budget/roster eligibility
 * @returns The resolved action to take
 */
export function resolveTimeoutAction(
  action: FastAuctionTimeoutAction,
  hasEligiblePlayer: boolean,
  eligibility: NominatorEligibility
): TimeoutResolution {
  if (action === 'auto_skip_nominator') {
    return 'skip';
  }

  if (!hasEligiblePlayer || !eligibility.eligible) {
    return 'skip';
  }

  if (action === 'auto_nominate_no_open_bid') {
    return 'create_lot_no_open_bid';
  }

  return 'create_lot_with_open_bid';
}
