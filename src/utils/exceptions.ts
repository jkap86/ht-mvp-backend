/**
 * Error codes for frontend to distinguish between error types.
 * Use these to provide intelligent error handling and user messaging.
 */
export const ErrorCode = {
  // Generic errors
  UNKNOWN_ERROR: 'UNKNOWN_ERROR',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  DATABASE_ERROR: 'DATABASE_ERROR',
  INTERNAL_ERROR: 'INTERNAL_ERROR',

  // Draft-specific errors (recoverable = can retry or wait)
  DRAFT_NOT_FOUND: 'DRAFT_NOT_FOUND',
  DRAFT_NOT_STARTED: 'DRAFT_NOT_STARTED',
  DRAFT_ALREADY_COMPLETED: 'DRAFT_ALREADY_COMPLETED',
  DRAFT_PAUSED: 'DRAFT_PAUSED',
  NOT_YOUR_TURN: 'NOT_YOUR_TURN',
  PLAYER_ALREADY_DRAFTED: 'PLAYER_ALREADY_DRAFTED',
  PICK_ALREADY_MADE: 'PICK_ALREADY_MADE',
  INVALID_PICK: 'INVALID_PICK',

  // Auction-specific errors
  AUCTION_LOT_NOT_FOUND: 'AUCTION_LOT_NOT_FOUND',
  AUCTION_LOT_EXPIRED: 'AUCTION_LOT_EXPIRED',
  AUCTION_BID_TOO_LOW: 'AUCTION_BID_TOO_LOW',
  AUCTION_INSUFFICIENT_BUDGET: 'AUCTION_INSUFFICIENT_BUDGET',
  AUCTION_NOT_YOUR_NOMINATION: 'AUCTION_NOT_YOUR_NOMINATION',
  AUCTION_GLOBAL_CAP_REACHED: 'AUCTION_GLOBAL_CAP_REACHED',
  AUCTION_DAILY_LIMIT_REACHED: 'AUCTION_DAILY_LIMIT_REACHED',

  // Trade-specific errors
  TRADE_NOT_FOUND: 'TRADE_NOT_FOUND',
  TRADE_ALREADY_PROCESSED: 'TRADE_ALREADY_PROCESSED',
  TRADE_INVALID_ASSETS: 'TRADE_INVALID_ASSETS',

  // Roster-specific errors
  ROSTER_FULL: 'ROSTER_FULL',
  PLAYER_NOT_ON_ROSTER: 'PLAYER_NOT_ON_ROSTER',
  PLAYER_ALREADY_ON_ROSTER: 'PLAYER_ALREADY_ON_ROSTER',

  // Lock errors
  LOCK_TIMEOUT: 'LOCK_TIMEOUT',
} as const;

export type ErrorCodeType = (typeof ErrorCode)[keyof typeof ErrorCode];

/**
 * Base class for application exceptions
 */
export class AppException extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly errorCode: ErrorCodeType = ErrorCode.UNKNOWN_ERROR
  ) {
    super(message);
    this.name = this.constructor.name;
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Thrown when validation fails
 */
export class ValidationException extends AppException {
  constructor(message: string, errorCode: ErrorCodeType = ErrorCode.VALIDATION_ERROR) {
    super(message, 400, errorCode);
  }
}

/**
 * Thrown when a request is invalid but not a validation error
 * (e.g., trying to perform an action that's not currently allowed)
 */
export class BadRequestException extends AppException {
  constructor(message: string, errorCode: ErrorCodeType = ErrorCode.VALIDATION_ERROR) {
    super(message, 400, errorCode);
  }
}

/**
 * Thrown when credentials are invalid
 */
export class InvalidCredentialsException extends AppException {
  constructor(message: string) {
    super(message, 401, ErrorCode.INVALID_CREDENTIALS);
  }
}

/**
 * Thrown when access is forbidden
 */
export class ForbiddenException extends AppException {
  constructor(message: string, errorCode: ErrorCodeType = ErrorCode.FORBIDDEN) {
    super(message, 403, errorCode);
  }
}

/**
 * Thrown when resource is not found
 */
export class NotFoundException extends AppException {
  constructor(message: string, errorCode: ErrorCodeType = ErrorCode.NOT_FOUND) {
    super(message, 404, errorCode);
  }
}

/**
 * Thrown when resource already exists or a conflict occurs
 */
export class ConflictException extends AppException {
  constructor(message: string, errorCode: ErrorCodeType = ErrorCode.CONFLICT) {
    super(message, 409, errorCode);
  }
}

/**
 * Thrown when a database operation fails.
 * Wraps the original error to prevent schema leakage.
 */
export class DatabaseException extends AppException {
  public readonly originalError?: Error;

  constructor(message: string, originalError?: Error) {
    super(message, 500, ErrorCode.DATABASE_ERROR);
    this.originalError = originalError;
  }

  /**
   * Creates a DatabaseException from a raw database error.
   * Logs the original error but returns a sanitized message.
   */
  static fromError(error: unknown, operation: string): DatabaseException {
    const originalError = error instanceof Error ? error : new Error(String(error));
    return new DatabaseException(
      `Database operation failed: ${operation}`,
      originalError
    );
  }
}

/**
 * Thrown when an advisory lock cannot be acquired within the configured timeout.
 * Indicates contention or a stuck transaction holding the lock.
 */
export class LockTimeoutError extends AppException {
  public readonly lockId: number;
  public readonly timeoutMs: number;

  constructor(lockId: number, timeoutMs: number, message?: string) {
    super(
      message ?? `Failed to acquire advisory lock ${lockId} within ${timeoutMs}ms`,
      409,
      ErrorCode.LOCK_TIMEOUT
    );
    this.lockId = lockId;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Thrown when an external API call fails (e.g., Sleeper, CFBD, ESPN).
 * Wraps the original error and provides context about the API and operation.
 */
export class ExternalApiException extends AppException {
  public readonly originalError?: Error;
  public readonly apiName: string;
  public readonly operation: string;
  public readonly statusCode: number;

  constructor(
    apiName: string,
    operation: string,
    message: string,
    statusCode: number = 502,
    originalError?: Error
  ) {
    super(`[${apiName}] ${operation}: ${message}`, statusCode, ErrorCode.INTERNAL_ERROR);
    this.apiName = apiName;
    this.operation = operation;
    this.originalError = originalError;
    this.statusCode = statusCode;
  }

  /**
   * Creates an ExternalApiException from a caught error.
   */
  static fromError(
    apiName: string,
    operation: string,
    error: unknown,
    statusCode: number = 502
  ): ExternalApiException {
    const originalError = error instanceof Error ? error : new Error(String(error));
    const message = originalError.message || 'Unknown error';
    return new ExternalApiException(apiName, operation, message, statusCode, originalError);
  }

  /**
   * Creates an ExternalApiException for timeout errors.
   */
  static timeout(apiName: string, operation: string): ExternalApiException {
    return new ExternalApiException(
      apiName,
      operation,
      'Request timed out',
      504,
      new Error('Timeout')
    );
  }

  /**
   * Creates an ExternalApiException for rate limit errors.
   */
  static rateLimited(apiName: string, operation: string): ExternalApiException {
    return new ExternalApiException(
      apiName,
      operation,
      'Rate limit exceeded',
      429,
      new Error('Rate limited')
    );
  }
}

// Domain-specific exception factory functions for common scenarios
export const DraftErrors = {
  notFound: (draftId: number) =>
    new NotFoundException(`Draft ${draftId} not found`, ErrorCode.DRAFT_NOT_FOUND),
  notStarted: () =>
    new ValidationException('Draft has not started', ErrorCode.DRAFT_NOT_STARTED),
  alreadyCompleted: () =>
    new ConflictException('Draft has already completed', ErrorCode.DRAFT_ALREADY_COMPLETED),
  paused: () =>
    new ValidationException('Draft is paused', ErrorCode.DRAFT_PAUSED),
  notYourTurn: () =>
    new ForbiddenException('It is not your turn to pick', ErrorCode.NOT_YOUR_TURN),
  playerAlreadyDrafted: () =>
    new ConflictException('Player has already been drafted', ErrorCode.PLAYER_ALREADY_DRAFTED),
  pickAlreadyMade: (expectedPick: number, currentPick: number | null) =>
    new ConflictException(
      `Pick already made. Expected pick ${expectedPick}, but draft is at pick ${currentPick}`,
      ErrorCode.PICK_ALREADY_MADE
    ),
};

export const AuctionErrors = {
  lotNotFound: (lotId: number) =>
    new NotFoundException(`Auction lot ${lotId} not found`, ErrorCode.AUCTION_LOT_NOT_FOUND),
  lotExpired: () =>
    new ConflictException('Auction lot has expired', ErrorCode.AUCTION_LOT_EXPIRED),
  bidTooLow: (minBid: number) =>
    new ValidationException(`Bid must be at least $${minBid}`, ErrorCode.AUCTION_BID_TOO_LOW),
  insufficientBudget: (available: number) =>
    new ValidationException(
      `Insufficient budget. Available: $${available}`,
      ErrorCode.AUCTION_INSUFFICIENT_BUDGET
    ),
  notYourNomination: () =>
    new ForbiddenException('It is not your turn to nominate', ErrorCode.AUCTION_NOT_YOUR_NOMINATION),
  globalCapReached: () =>
    new ValidationException(
      'Global nomination cap reached - no more nominations allowed',
      ErrorCode.AUCTION_GLOBAL_CAP_REACHED
    ),
  dailyLimitReached: () =>
    new ValidationException(
      'Daily nomination limit reached',
      ErrorCode.AUCTION_DAILY_LIMIT_REACHED
    ),
};

export const RosterErrors = {
  full: (maxSize: number) =>
    new ValidationException(`Roster is full (max ${maxSize} players)`, ErrorCode.ROSTER_FULL),
  playerNotOnRoster: () =>
    new NotFoundException('Player is not on this roster', ErrorCode.PLAYER_NOT_ON_ROSTER),
  playerAlreadyOnRoster: () =>
    new ConflictException('Player is already on this roster', ErrorCode.PLAYER_ALREADY_ON_ROSTER),
};
