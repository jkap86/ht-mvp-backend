import { BaseDraftEngine } from './base-draft.engine';
import { Draft, DraftOrderEntry } from '../modules/drafts/drafts.model';

/**
 * Linear draft engine.
 * In linear drafts, pick order stays the same every round:
 *   Round 1: Team1, Team2, Team3, Team4
 *   Round 2: Team1, Team2, Team3, Team4
 *   Round 3: Team1, Team2, Team3, Team4
 *
 * This gives earlier picks a significant advantage,
 * but is simpler to understand.
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
    const totalRosters = draftOrder.length;
    const pickInRound = this.getPickInRound(pickNumber, totalRosters);

    // Linear: same order every round
    return draftOrder.find((o) => o.draftPosition === pickInRound);
  }
}
