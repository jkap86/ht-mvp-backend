/**
 * Shared utility for computing the next pick state in a draft.
 *
 * Extracted from three duplicated implementations:
 * - BaseDraftEngine.computeNextPickState()
 * - DraftPickService.computeNextPickState()
 * - DraftStateService.computeNextPickState()
 *
 * This is a pure function with no side effects or DB calls.
 */

import { Draft, DraftOrderEntry } from './drafts.model';
import { DraftPickAsset } from './draft-pick-asset.model';
import { IDraftEngine } from '../../engines/draft-engine.interface';

/**
 * Represents the computed state for the next pick in a draft.
 * Used by makePickAndAdvanceTx and makePickAssetSelectionTx to atomically
 * update draft state after a pick is recorded.
 */
export interface NextPickState {
  currentPick: number | null;
  currentRound: number | null;
  currentRosterId: number | null;
  originalRosterId: number | null;
  isTraded: boolean;
  pickDeadline: Date | null;
  status?: 'in_progress' | 'completed';
  completedAt?: Date | null;
}

/** Context for chess clock deadline calculation */
export interface ChessClockContext {
  remainingSeconds: number;
}

/**
 * Pre-compute the next pick state without making any DB changes.
 *
 * Given the current draft state, draft order, engine, and pick assets,
 * determines what the draft state should be after the current pick is made.
 *
 * Handles:
 * - Next pick number calculation
 * - Round advancement
 * - Roster determination (accounting for traded picks)
 * - Draft completion detection
 * - Pick deadline calculation
 *
 * @param draft - The current draft state
 * @param draftOrder - The draft order entries
 * @param engine - The draft engine (provides pick order logic and deadline calculation)
 * @param pickAssets - Draft pick assets for traded pick awareness (default: [])
 * @param chessClockContext - Optional chess clock context for the next picker
 * @returns The computed next pick state
 */
export function computeNextPickState(
  draft: Draft,
  draftOrder: DraftOrderEntry[],
  engine: IDraftEngine,
  pickAssets: DraftPickAsset[] = [],
  chessClockContext?: ChessClockContext
): NextPickState {
  const totalRosters = draftOrder.length;
  const totalPicks = totalRosters * draft.rounds;
  const nextPick = draft.currentPick + 1;

  if (nextPick > totalPicks) {
    // Draft complete
    return {
      currentPick: null,
      currentRound: null,
      currentRosterId: null,
      originalRosterId: null,
      isTraded: false,
      pickDeadline: null,
      status: 'completed',
      completedAt: new Date(),
    };
  }

  const nextRound = engine.getRound(nextPick, totalRosters);

  // Use getActualPickerForPickNumber to account for traded picks
  const actualPicker = engine.getActualPickerForPickNumber?.(
    draft,
    draftOrder,
    pickAssets,
    nextPick
  );

  // Fall back to original picker logic if engine doesn't support traded picks
  const originalPicker = engine.getPickerForPickNumber(draft, draftOrder, nextPick);
  const nextPickerRosterId = actualPicker?.rosterId ?? originalPicker?.rosterId ?? null;

  const pickDeadline = engine.calculatePickDeadline(draft, {
    chessClockRemainingSeconds: chessClockContext?.remainingSeconds,
  });

  return {
    currentPick: nextPick,
    currentRound: nextRound,
    currentRosterId: nextPickerRosterId,
    originalRosterId: actualPicker?.originalRosterId ?? originalPicker?.rosterId ?? null,
    isTraded: actualPicker?.isTraded ?? false,
    pickDeadline,
    status: 'in_progress',
  };
}
