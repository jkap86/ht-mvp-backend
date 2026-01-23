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
