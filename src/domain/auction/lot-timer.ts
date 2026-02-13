/**
 * Auction Lot Timer Domain Logic
 *
 * Pure functions for lot timer extension rules.
 * No async I/O, no database access.
 */

export interface TimerExtensionResult {
  shouldExtend: boolean;
  newDeadline: Date;
}

/**
 * Compute whether and how to extend a lot's bid deadline.
 *
 * Rules:
 * 1. New deadline = now + resetOnBidSeconds
 * 2. Cap at lot creation time + maxLotDurationSeconds (if configured)
 * 3. Only extend, never shorten (new deadline must be > current deadline)
 *
 * @param now - Current time
 * @param currentDeadline - The lot's current bid deadline
 * @param lotCreatedAt - When the lot was created (for max duration cap)
 * @param resetOnBidSeconds - Seconds to add on each qualifying bid
 * @param maxLotDurationSeconds - Maximum lot duration in seconds (null = no cap)
 * @returns Whether to extend and the new deadline
 */
export function computeExtendedDeadline(
  now: Date,
  currentDeadline: Date,
  lotCreatedAt: Date,
  resetOnBidSeconds: number,
  maxLotDurationSeconds: number | null
): TimerExtensionResult {
  let newDeadline = new Date(now.getTime() + resetOnBidSeconds * 1000);

  // Cap at max lot duration if configured
  if (maxLotDurationSeconds !== null) {
    const maxDeadline = new Date(lotCreatedAt.getTime() + maxLotDurationSeconds * 1000);
    if (newDeadline > maxDeadline) {
      newDeadline = maxDeadline;
    }
  }

  // Only extend, never shorten
  const shouldExtend = newDeadline > currentDeadline;

  return {
    shouldExtend,
    newDeadline: shouldExtend ? newDeadline : currentDeadline,
  };
}
