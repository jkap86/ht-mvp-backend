import { BaseDraftEngine } from './base-draft.engine';
import type { Draft, DraftOrderEntry } from '../modules/drafts/drafts.model';

/**
 * Linear draft engine.
 * In linear drafts, pick order stays the same every round:
 *   Round 1: Team1, Team2, Team3, Team4
 *   Round 2: Team1, Team2, Team3, Team4
 *   Round 3: Team1, Team2, Team3, Team4
 *
 * This gives earlier picks a significant advantage,
 * but is simpler to understand.
 *
 * LOCK CONTRACT:
 * Inherits from BaseDraftEngine. No additional locks acquired.
 * All lock acquisition happens in the base class (DRAFT lock via runInDraftTransaction).
 */
export class LinearDraftEngine extends BaseDraftEngine {
  readonly draftType = 'linear';

  /**
   * Get the roster that should pick at a given pick number.
   * For linear drafts, order is always the same regardless of round.
   */
  getPickerForPickNumber(
    draft: Draft,
    draftOrder: DraftOrderEntry[],
    pickNumber: number
  ): DraftOrderEntry | undefined {
    // Defensive assertion: validate draftOrder is sorted by draftPosition
    // This assumption is critical for correct draft order calculation
    if (draftOrder.length > 1) {
      const isSorted = draftOrder.every(
        (o, i) => i === 0 || o.draftPosition > draftOrder[i - 1].draftPosition
      );
      if (!isSorted) {
        throw new Error('draftOrder must be sorted by draftPosition');
      }
    }

    const totalRosters = draftOrder.length;
    const pickInRound = this.getPickInRound(pickNumber, totalRosters);

    // Linear: same order every round
    return draftOrder.find((o) => o.draftPosition === pickInRound);
  }
}
