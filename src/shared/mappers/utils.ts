/**
 * Shared Mapper Utilities
 *
 * Generic snake_case <-> camelCase object key conversion functions.
 * Used by model fromDatabase/toResponse functions to eliminate repetitive
 * field-by-field key mapping.
 *
 * These utilities only convert top-level keys. For nested objects, type
 * coercion (e.g. parseFloat), or default values, keep explicit mapping
 * in the model's fromDatabase/toResponse functions and use these as
 * building blocks.
 */

import { toCamelCase, toSnakeCase } from '../query-builder';

/**
 * Convert a snake_case database row to a camelCase object.
 * Only converts top-level keys; values are passed through unchanged.
 *
 * @example
 * const row = { id: 1, league_id: 5, created_at: new Date() };
 * const obj = snakeToCamel<MyType>(row);
 * // { id: 1, leagueId: 5, createdAt: Date }
 */
export function snakeToCamel<T = Record<string, unknown>>(
  row: Record<string, unknown>
): T {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(row)) {
    const camelKey = toCamelCase(key);
    result[camelKey] = row[key];
  }
  return result as T;
}

/**
 * Convert a camelCase object to snake_case for database operations or API responses.
 * Only converts top-level keys; values are passed through unchanged.
 *
 * @example
 * const obj = { id: 1, leagueId: 5, createdAt: new Date() };
 * const row = camelToSnake(obj);
 * // { id: 1, league_id: 5, created_at: Date }
 */
export function camelToSnake(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    const snakeKey = toSnakeCase(key);
    result[snakeKey] = obj[key];
  }
  return result;
}

/**
 * Convert a snake_case database row to a camelCase object, applying only
 * the specified fields. Fields not in the pick list are ignored.
 *
 * Useful when a query returns joined columns and you only want a subset
 * mapped into a specific type.
 *
 * @example
 * const row = { id: 1, league_id: 5, extra_col: 'ignored' };
 * const obj = snakeToCamelPick<MyType>(row, ['id', 'league_id']);
 * // { id: 1, leagueId: 5 }
 */
export function snakeToCamelPick<T = Record<string, unknown>>(
  row: Record<string, unknown>,
  snakeKeys: string[]
): T {
  const result: Record<string, unknown> = {};
  for (const key of snakeKeys) {
    if (key in row) {
      const camelKey = toCamelCase(key);
      result[camelKey] = row[key];
    }
  }
  return result as T;
}

/**
 * Batch convert an array of snake_case rows to camelCase objects.
 *
 * @example
 * const rows = [{ league_id: 1 }, { league_id: 2 }];
 * const objs = snakeToCamelRows<MyType>(rows);
 */
export function snakeToCamelRows<T = Record<string, unknown>>(
  rows: Record<string, unknown>[]
): T[] {
  return rows.map((row) => snakeToCamel<T>(row));
}
