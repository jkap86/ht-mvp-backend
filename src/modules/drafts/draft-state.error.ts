/**
 * Error thrown when an operation is attempted on a draft in an invalid state.
 *
 * This error is used to prevent operations like making picks, undoing picks,
 * or modifying queues when the draft is not in the appropriate state (e.g., completed, not started).
 */
export class DraftStateError extends Error {
  constructor(
    message: string,
    public readonly context: Record<string, any> = {}
  ) {
    super(message);
    this.name = 'DraftStateError';

    // Maintains proper stack trace for where our error was thrown (only available on V8)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, DraftStateError);
    }
  }
}
