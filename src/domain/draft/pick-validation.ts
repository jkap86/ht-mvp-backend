/**
 * Draft Pick Validation Domain Logic
 *
 * Pure functions for validating pick preconditions.
 * No async I/O, no database access.
 */

export type DraftPickErrorCode =
  | 'DRAFT_NOT_IN_PROGRESS'
  | 'DRAFT_NOT_STARTED_YET'
  | 'ORDER_NOT_CONFIRMED'
  | 'NOT_YOUR_TURN'
  | 'PICK_DEADLINE_PASSED';

export interface DraftPickError {
  code: DraftPickErrorCode;
  message: string;
}

/**
 * Minimal draft context needed for pick validation.
 * Domain does not import from modules — callers map from their Draft type.
 */
export interface PickValidationContext {
  status: string;
  draftType: string;
  scheduledStart: Date | null;
  orderConfirmed: boolean;
  currentPick: number;
  pickDeadline: Date | null;
  currentPickerRosterId: number | null;
}

/**
 * Validate preconditions for making a draft pick.
 *
 * Checks:
 * 1. Draft is in progress
 * 2. Scheduled start time has passed (if set)
 * 3. Order is confirmed (non-auction drafts)
 * 4. It is the picker's turn (non-autopick only)
 * 5. Pick deadline has not passed
 *
 * @param ctx - Draft state snapshot
 * @param pickerRosterId - The roster attempting to make the pick
 * @param now - Current time (injected for testability)
 * @param isAutoPick - Whether this is a system-initiated autopick
 * @returns Array of validation errors (empty if valid)
 */
export function validatePickPreconditions(
  ctx: PickValidationContext,
  pickerRosterId: number,
  now: Date,
  isAutoPick: boolean = false
): DraftPickError[] {
  const errors: DraftPickError[] = [];

  if (ctx.status !== 'in_progress') {
    errors.push({
      code: 'DRAFT_NOT_IN_PROGRESS',
      message: 'Draft is not in progress',
    });
    return errors; // No point checking further
  }

  if (ctx.scheduledStart && now < ctx.scheduledStart) {
    errors.push({
      code: 'DRAFT_NOT_STARTED_YET',
      message: 'Draft has not started yet',
    });
  }

  if (!ctx.orderConfirmed && ctx.draftType !== 'auction') {
    errors.push({
      code: 'ORDER_NOT_CONFIRMED',
      message: 'Draft order must be confirmed before making picks',
    });
  }

  if (!isAutoPick && ctx.currentPickerRosterId !== null && ctx.currentPickerRosterId !== pickerRosterId) {
    errors.push({
      code: 'NOT_YOUR_TURN',
      message: 'It is not your turn to pick',
    });
  }

  if (ctx.pickDeadline && now > ctx.pickDeadline) {
    errors.push({
      code: 'PICK_DEADLINE_PASSED',
      message: 'Pick deadline has passed',
    });
  }

  return errors;
}
