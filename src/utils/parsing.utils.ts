/**
 * Safe parsing utilities for user input.
 *
 * These helpers provide validation and consistent error messages
 * for parsing string values from requests.
 */

import { ValidationException } from '../shared/exceptions/validation.exception';

/**
 * Safely parse an ID from a string with validation.
 *
 * @param value - The string value to parse
 * @param name - The name of the field for error messages (default: 'id')
 * @returns The parsed positive integer ID
 * @throws ValidationException if value is missing, not a number, or not positive
 *
 * @example
 * const userId = parseId(req.params.userId, 'userId');
 * const leagueId = parseId(req.query.leagueId, 'leagueId');
 */
export function parseId(value: string | undefined, name = 'id'): number {
  if (!value) {
    throw new ValidationException(`${name} is required`);
  }

  const id = parseInt(value, 10);

  if (isNaN(id)) {
    throw new ValidationException(`${name} must be a valid number`);
  }

  if (id <= 0) {
    throw new ValidationException(`${name} must be a positive integer`);
  }

  return id;
}

/**
 * Safely parse an optional ID from a string with validation.
 *
 * @param value - The string value to parse
 * @param name - The name of the field for error messages (default: 'id')
 * @returns The parsed positive integer ID, or undefined if not provided
 * @throws ValidationException if value is provided but invalid
 *
 * @example
 * const optionalWeek = parseOptionalId(req.query.week, 'week');
 */
export function parseOptionalId(
  value: string | undefined,
  name = 'id'
): number | undefined {
  if (!value) {
    return undefined;
  }

  return parseId(value, name);
}

/**
 * Safely parse an integer from a string with validation.
 *
 * Similar to parseId but allows zero and negative numbers.
 *
 * @param value - The string value to parse
 * @param name - The name of the field for error messages
 * @returns The parsed integer
 * @throws ValidationException if value is missing or not a number
 *
 * @example
 * const score = parseInteger(req.body.score, 'score');
 */
export function parseInteger(value: string | undefined, name: string): number {
  if (!value) {
    throw new ValidationException(`${name} is required`);
  }

  const num = parseInt(value, 10);

  if (isNaN(num)) {
    throw new ValidationException(`${name} must be a valid integer`);
  }

  return num;
}

/**
 * Safely parse an optional integer from a string with validation.
 *
 * @param value - The string value to parse
 * @param name - The name of the field for error messages
 * @returns The parsed integer, or undefined if not provided
 * @throws ValidationException if value is provided but invalid
 *
 * @example
 * const offset = parseOptionalInteger(req.query.offset, 'offset');
 */
export function parseOptionalInteger(
  value: string | undefined,
  name: string
): number | undefined {
  if (!value) {
    return undefined;
  }

  return parseInteger(value, name);
}
