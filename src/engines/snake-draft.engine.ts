import { BaseDraftEngine } from './base-draft.engine';
import { Draft, DraftOrderEntry } from '../modules/drafts/drafts.model';

/**
 * Snake draft engine.
 * In snake drafts, pick order reverses every round:
 * - Odd rounds (1, 3, 5...): picks go 1→N
 * - Even rounds (2, 4, 6...): picks go N→1
 *
 * Example with 4 teams:
 *   Round 1: Team1, Team2, Team3, Team4
 *   Round 2: Team4, Team3, Team2, Team1
 *   Round 3: Team1, Team2, Team3, Team4
 */
export class SnakeDraftEngine extends BaseDraftEngine {
  readonly draftType = 'snake';

  /**
   * Get the roster that should pick at a given pick number.
   * For snake drafts, even rounds have reversed pick order.
   */
  getPickerForPickNumber(
    draft: Draft,
    draftOrder: DraftOrderEntry[],
    pickNumber: number
  ): DraftOrderEntry | undefined {
    const totalRosters = draftOrder.length;
    const round = this.getRound(pickNumber, totalRosters);
    const pickInRound = this.getPickInRound(pickNumber, totalRosters);

    // Snake draft: reverse order in even rounds
    const isReversed = round % 2 === 0;
    const position = isReversed
      ? totalRosters - pickInRound + 1
      : pickInRound;

    return draftOrder.find(o => o.draftPosition === position);
  }
}
