/**
 * Base class for application exceptions
 */
export class AppException extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly errorCode: string = 'UNKNOWN_ERROR'
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
  constructor(message: string) {
    super(message, 400, 'VALIDATION_ERROR');
  }
}

/**
 * Thrown when credentials are invalid
 */
export class InvalidCredentialsException extends AppException {
  constructor(message: string) {
    super(message, 401, 'INVALID_CREDENTIALS');
  }
}

/**
 * Thrown when access is forbidden
 */
export class ForbiddenException extends AppException {
  constructor(message: string) {
    super(message, 403, 'FORBIDDEN');
  }
}

/**
 * Thrown when resource is not found
 */
export class NotFoundException extends AppException {
  constructor(message: string) {
    super(message, 404, 'NOT_FOUND');
  }
}

/**
 * Thrown when resource already exists
 */
export class ConflictException extends AppException {
  constructor(message: string) {
    super(message, 409, 'CONFLICT');
  }
}

/**
 * Thrown when a database operation fails.
 * Wraps the original error to prevent schema leakage.
 */
export class DatabaseException extends AppException {
  public readonly originalError?: Error;

  constructor(message: string, originalError?: Error) {
    super(message, 500, 'DATABASE_ERROR');
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
