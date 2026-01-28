import { Draft, DraftOrderEntry, DraftPick } from '../modules/drafts/drafts.model';

/**
 * Result of a draft tick operation
 */
export interface DraftTickResult {
  /** Whether any action was taken */
  actionTaken: boolean;
  /** The pick made (if any) */
  pick?: DraftPick;
  /** Whether draft is now complete */
  draftCompleted: boolean;
  /** Updated draft state */
  draft: Draft;
  /** Next picker info (if draft continues) */
  nextPicker?: DraftOrderEntry | null;
  /** Reason for action (for logging) */
  reason?: 'timeout' | 'autodraft' | 'none';
}

/**
 * Details about the next pick in a draft.
 * Field names match frontend expectations for socket events.
 */
export interface NextPickDetails {
  currentPick: number;
  currentRound: number;
  currentRosterId: number | null;
  pickDeadline: Date;
  status?: string;  // Optional: 'in_progress'
}

/**
 * Interface for draft engines.
 * Each draft type (snake, linear, auction) implements this interface
 * with its own pick order and advancement logic.
 */
export interface IDraftEngine {
  /**
   * The draft type this engine handles
   */
  readonly draftType: string;

  /**
   * Get the roster that should pick at a given pick number.
   * Handles snake reversal, linear order, etc.
   */
  getPickerForPickNumber(
    draft: Draft,
    draftOrder: DraftOrderEntry[],
    pickNumber: number
  ): DraftOrderEntry | undefined;

  /**
   * Calculate which pick within a round this is (1-indexed)
   */
  getPickInRound(pickNumber: number, totalRosters: number): number;

  /**
   * Calculate which round a given pick falls into (1-indexed)
   */
  getRound(pickNumber: number, totalRosters: number): number;

  /**
   * Check if draft is complete after a given pick number
   */
  isDraftComplete(draft: Draft, afterPickNumber: number): boolean;

  /**
   * Get details about the next pick after current pick.
   * Returns null if draft is complete.
   */
  getNextPickDetails(
    draft: Draft,
    draftOrder: DraftOrderEntry[]
  ): NextPickDetails | null;

  /**
   * Check if it's time for an autopick based on deadline
   */
  shouldAutoPick(draft: Draft): boolean;

  /**
   * Calculate deadline for the next pick
   */
  calculatePickDeadline(draft: Draft): Date;

  /**
   * Process a tick - called periodically to handle time-based actions.
   * If deadline has expired, performs an autopick.
   * Returns result indicating what action was taken (if any).
   */
  tick(draftId: number): Promise<DraftTickResult>;
}
