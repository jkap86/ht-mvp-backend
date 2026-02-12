import { logger } from '../config/logger.config';
import { AppException, DatabaseException } from './exceptions';

/**
 * Wraps a database operation and converts raw database errors to sanitized DatabaseException.
 * Logs the original error for debugging while returning a safe message to clients.
 *
 * @param operation - Description of the operation for logging
 * @param fn - The async function to execute
 * @returns The result of the function
 * @throws DatabaseException if the operation fails
 */
export async function withDbErrorHandling<T>(
  operation: string,
  fn: () => Promise<T>
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    // Log the full error for debugging
    logger.error(`Database error during ${operation}:`, error);

    // Check if it's already a known application error (rethrow as-is)
    if (isAppError(error)) {
      throw error;
    }

    // Wrap raw database errors in a sanitized exception
    throw DatabaseException.fromError(error, operation);
  }
}

/**
 * Checks if an error is already an application-level error (not a raw db error)
 */
function isAppError(error: unknown): boolean {
  return error instanceof AppException;
}

/**
 * Higher-order function that wraps a repository method with error handling
 *
 * @param methodName - Name of the method for logging
 * @returns A function wrapper that adds error handling
 *
 * @example
 * const findById = wrapDbMethod('findById')(async (id: number) => {
 *   const result = await db.query('SELECT * FROM users WHERE id = $1', [id]);
 *   return result.rows[0];
 * });
 */
export function wrapDbMethod<TArgs extends unknown[], TReturn>(
  methodName: string
): (fn: (...args: TArgs) => Promise<TReturn>) => (...args: TArgs) => Promise<TReturn> {
  return (fn) => {
    return async (...args) => {
      return withDbErrorHandling(methodName, () => fn(...args));
    };
  };
}
