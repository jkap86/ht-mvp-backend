/**
 * Helper functions for calculating draft pick positions.
 * Handles both snake and linear draft order logic.
 */

export interface DraftOrderEntry {
  rosterId: number;
  draftPosition: number;
  [key: string]: any;
}

/**
 * Get the roster that should pick at a given position in a draft.
 *
 * @param round - Current round number (1-indexed)
 * @param pick - Overall pick number (1-indexed)
 * @param draftType - 'snake' or 'linear'
 * @param draftOrder - Array of draft order entries with draftPosition
 * @returns The draft order entry for the picker, or undefined if not found
 */
export function getPickerByPosition(
  round: number,
  pick: number,
  draftType: string,
  draftOrder: DraftOrderEntry[]
): DraftOrderEntry | undefined {
  const totalRosters = draftOrder.length;
  const pickInRound = ((pick - 1) % totalRosters) + 1;

  // Snake draft: reverse order in even rounds
  const position = (draftType === 'snake' && round % 2 === 0)
    ? totalRosters - pickInRound + 1
    : pickInRound;

  return draftOrder.find(o => o.draftPosition === position);
}

/**
 * Calculate which round a given pick falls into.
 *
 * @param pick - Overall pick number (1-indexed)
 * @param totalRosters - Number of teams in the draft
 * @returns Round number (1-indexed)
 */
export function calculateRound(pick: number, totalRosters: number): number {
  return Math.ceil(pick / totalRosters);
}

/**
 * Calculate the pick position within a round.
 *
 * @param pick - Overall pick number (1-indexed)
 * @param totalRosters - Number of teams in the draft
 * @returns Pick number within the round (1-indexed)
 */
export function calculatePickInRound(pick: number, totalRosters: number): number {
  return ((pick - 1) % totalRosters) + 1;
}
