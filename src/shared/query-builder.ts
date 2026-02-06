/**
 * Query Builder Utility
 *
 * Provides helpers for building parameterized SQL queries dynamically.
 * Eliminates manual paramIndex tracking across repository files.
 */

/**
 * Result of building a query with parameters.
 */
export interface QueryResult {
  query: string;
  values: any[];
}

/**
 * Column mapping from camelCase property names to snake_case database columns.
 * Used for automatic conversion in update/insert builders.
 */
export type ColumnMapping = Record<string, string>;

/**
 * Converts a camelCase string to snake_case.
 */
export function toSnakeCase(str: string): string {
  return str.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

/**
 * Converts a snake_case string to camelCase.
 */
export function toCamelCase(str: string): string {
  return str.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}

/**
 * Builds a parameterized UPDATE query from a partial object.
 * Automatically handles parameter indexing and snake_case conversion.
 *
 * @param table - Table name
 * @param updates - Object with fields to update (uses camelCase keys)
 * @param whereColumn - Column name for WHERE clause (snake_case)
 * @param whereValue - Value for WHERE clause
 * @param options - Optional configuration
 * @returns Query string and values array
 *
 * @example
 * const { query, values } = buildUpdateQuery(
 *   'drafts',
 *   { status: 'completed', currentPick: 15, currentRound: 2 },
 *   'id',
 *   draftId
 * );
 * // query: "UPDATE drafts SET status = $1, current_pick = $2, current_round = $3, updated_at = CURRENT_TIMESTAMP WHERE id = $4 RETURNING *"
 * // values: ['completed', 15, 2, draftId]
 */
export function buildUpdateQuery(
  table: string,
  updates: Record<string, any>,
  whereColumn: string,
  whereValue: any,
  options: {
    /** Custom column mapping (camelCase -> snake_case) */
    columnMapping?: ColumnMapping;
    /** Whether to add updated_at = CURRENT_TIMESTAMP (default: true) */
    addUpdatedAt?: boolean;
    /** Whether to add RETURNING * (default: true) */
    returning?: boolean;
    /** Custom RETURNING clause (overrides returning option) */
    returningColumns?: string[];
  } = {}
): QueryResult {
  const {
    columnMapping = {},
    addUpdatedAt = true,
    returning = true,
    returningColumns,
  } = options;

  const setClauses: string[] = [];
  const values: any[] = [];
  let paramIndex = 1;

  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) continue;

    // Use custom mapping if provided, otherwise convert camelCase to snake_case
    const column = columnMapping[key] || toSnakeCase(key);
    setClauses.push(`${column} = $${paramIndex++}`);
    values.push(value);
  }

  if (setClauses.length === 0) {
    throw new Error('No fields to update');
  }

  if (addUpdatedAt) {
    setClauses.push('updated_at = CURRENT_TIMESTAMP');
  }

  values.push(whereValue);

  let query = `UPDATE ${table} SET ${setClauses.join(', ')} WHERE ${whereColumn} = $${paramIndex}`;

  if (returningColumns) {
    query += ` RETURNING ${returningColumns.join(', ')}`;
  } else if (returning) {
    query += ' RETURNING *';
  }

  return { query, values };
}

/**
 * Builds a parameterized UPDATE query with multiple WHERE conditions.
 *
 * @param table - Table name
 * @param updates - Object with fields to update
 * @param whereConditions - Array of { column, value } conditions (ANDed together)
 * @param options - Optional configuration
 * @returns Query string and values array
 *
 * @example
 * const { query, values } = buildUpdateQueryMultiWhere(
 *   'auction_lots',
 *   { currentBid: 50, status: 'active' },
 *   [
 *     { column: 'id', value: lotId },
 *     { column: 'current_bid', value: expectedBid }, // CAS check
 *   ]
 * );
 */
export function buildUpdateQueryMultiWhere(
  table: string,
  updates: Record<string, any>,
  whereConditions: Array<{ column: string; value: any }>,
  options: {
    columnMapping?: ColumnMapping;
    addUpdatedAt?: boolean;
    returning?: boolean;
    returningColumns?: string[];
  } = {}
): QueryResult {
  const {
    columnMapping = {},
    addUpdatedAt = true,
    returning = true,
    returningColumns,
  } = options;

  const setClauses: string[] = [];
  const values: any[] = [];
  let paramIndex = 1;

  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) continue;
    const column = columnMapping[key] || toSnakeCase(key);
    setClauses.push(`${column} = $${paramIndex++}`);
    values.push(value);
  }

  if (setClauses.length === 0) {
    throw new Error('No fields to update');
  }

  if (addUpdatedAt) {
    setClauses.push('updated_at = CURRENT_TIMESTAMP');
  }

  const whereClauses: string[] = [];
  for (const { column, value } of whereConditions) {
    whereClauses.push(`${column} = $${paramIndex++}`);
    values.push(value);
  }

  let query = `UPDATE ${table} SET ${setClauses.join(', ')} WHERE ${whereClauses.join(' AND ')}`;

  if (returningColumns) {
    query += ` RETURNING ${returningColumns.join(', ')}`;
  } else if (returning) {
    query += ' RETURNING *';
  }

  return { query, values };
}

/**
 * Builds a parameterized batch INSERT query.
 *
 * @param table - Table name
 * @param columns - Array of column names (snake_case)
 * @param rows - Array of value arrays, each corresponding to columns
 * @param options - Optional configuration
 * @returns Query string and values array
 *
 * @example
 * const { query, values } = buildBatchInsertQuery(
 *   'draft_order',
 *   ['draft_id', 'roster_id', 'draft_position'],
 *   [
 *     [draftId, roster1, 1],
 *     [draftId, roster2, 2],
 *     [draftId, roster3, 3],
 *   ]
 * );
 * // query: "INSERT INTO draft_order (draft_id, roster_id, draft_position) VALUES ($1, $2, $3), ($4, $5, $6), ($7, $8, $9)"
 */
export function buildBatchInsertQuery(
  table: string,
  columns: string[],
  rows: any[][],
  options: {
    /** ON CONFLICT clause (e.g., '(id) DO NOTHING') */
    onConflict?: string;
    /** Whether to add RETURNING * (default: false) */
    returning?: boolean;
    /** Custom RETURNING clause */
    returningColumns?: string[];
  } = {}
): QueryResult {
  const { onConflict, returning = false, returningColumns } = options;

  if (rows.length === 0) {
    throw new Error('No rows to insert');
  }

  const values: any[] = [];
  const placeholders: string[] = [];
  let paramIndex = 1;

  for (const row of rows) {
    if (row.length !== columns.length) {
      throw new Error(`Row has ${row.length} values but ${columns.length} columns specified`);
    }

    const rowPlaceholders = row.map(() => `$${paramIndex++}`);
    placeholders.push(`(${rowPlaceholders.join(', ')})`);
    values.push(...row);
  }

  let query = `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${placeholders.join(', ')}`;

  if (onConflict) {
    query += ` ON CONFLICT ${onConflict}`;
  }

  if (returningColumns) {
    query += ` RETURNING ${returningColumns.join(', ')}`;
  } else if (returning) {
    query += ' RETURNING *';
  }

  return { query, values };
}

/**
 * Builds a parameterized batch INSERT query from objects.
 * Automatically converts camelCase keys to snake_case columns.
 *
 * @param table - Table name
 * @param objects - Array of objects to insert
 * @param options - Optional configuration
 * @returns Query string and values array
 *
 * @example
 * const { query, values } = buildBatchInsertFromObjects(
 *   'draft_picks',
 *   [
 *     { draftId: 1, playerId: 100, rosterId: 5 },
 *     { draftId: 1, playerId: 101, rosterId: 6 },
 *   ]
 * );
 */
export function buildBatchInsertFromObjects(
  table: string,
  objects: Record<string, any>[],
  options: {
    /** Custom column mapping (camelCase -> snake_case) */
    columnMapping?: ColumnMapping;
    /** ON CONFLICT clause */
    onConflict?: string;
    /** Whether to add RETURNING * */
    returning?: boolean;
    /** Custom RETURNING clause */
    returningColumns?: string[];
  } = {}
): QueryResult {
  const { columnMapping = {}, ...restOptions } = options;

  if (objects.length === 0) {
    throw new Error('No objects to insert');
  }

  // Get columns from first object (assumes all objects have same shape)
  const keys = Object.keys(objects[0]).filter((k) => objects[0][k] !== undefined);
  const columns = keys.map((k) => columnMapping[k] || toSnakeCase(k));

  const rows = objects.map((obj) => keys.map((k) => obj[k]));

  return buildBatchInsertQuery(table, columns, rows, restOptions);
}

/**
 * Builds a parameterized SELECT query with dynamic WHERE conditions.
 *
 * @param table - Table name
 * @param conditions - Object with conditions (undefined values are skipped)
 * @param options - Optional configuration
 * @returns Query string and values array
 *
 * @example
 * const { query, values } = buildSelectQuery(
 *   'players',
 *   { position: 'QB', team: 'KC', active: true },
 *   { orderBy: 'full_name', limit: 100 }
 * );
 * // query: "SELECT * FROM players WHERE position = $1 AND team = $2 AND active = $3 ORDER BY full_name LIMIT $4"
 */
export function buildSelectQuery(
  table: string,
  conditions: Record<string, any>,
  options: {
    /** Columns to select (default: '*') */
    columns?: string[];
    /** Column mapping for conditions */
    columnMapping?: ColumnMapping;
    /** ORDER BY clause */
    orderBy?: string;
    /** ORDER BY direction */
    orderDirection?: 'ASC' | 'DESC';
    /** LIMIT value */
    limit?: number;
    /** OFFSET value */
    offset?: number;
  } = {}
): QueryResult {
  const {
    columns = ['*'],
    columnMapping = {},
    orderBy,
    orderDirection = 'ASC',
    limit,
    offset,
  } = options;

  const whereClauses: string[] = [];
  const values: any[] = [];
  let paramIndex = 1;

  for (const [key, value] of Object.entries(conditions)) {
    if (value === undefined) continue;
    const column = columnMapping[key] || toSnakeCase(key);
    whereClauses.push(`${column} = $${paramIndex++}`);
    values.push(value);
  }

  let query = `SELECT ${columns.join(', ')} FROM ${table}`;

  if (whereClauses.length > 0) {
    query += ` WHERE ${whereClauses.join(' AND ')}`;
  }

  if (orderBy) {
    query += ` ORDER BY ${orderBy} ${orderDirection}`;
  }

  if (limit !== undefined) {
    query += ` LIMIT $${paramIndex++}`;
    values.push(limit);
  }

  if (offset !== undefined) {
    query += ` OFFSET $${paramIndex++}`;
    values.push(offset);
  }

  return { query, values };
}

/**
 * Helper class for building queries with fluent API.
 * Use for complex queries that need incremental construction.
 */
export class QueryBuilder {
  private values: any[] = [];
  private paramIndex = 1;
  private parts: string[] = [];

  /**
   * Add a parameter and get its placeholder.
   */
  addParam(value: any): string {
    this.values.push(value);
    return `$${this.paramIndex++}`;
  }

  /**
   * Add multiple parameters and get their placeholders.
   */
  addParams(values: any[]): string[] {
    return values.map((v) => this.addParam(v));
  }

  /**
   * Add a query part.
   */
  append(sql: string): this {
    this.parts.push(sql);
    return this;
  }

  /**
   * Add a conditional WHERE clause.
   */
  addCondition(column: string, value: any, operator = '='): this {
    if (value !== undefined) {
      this.parts.push(`${column} ${operator} ${this.addParam(value)}`);
    }
    return this;
  }

  /**
   * Get the current parameter index (for external use).
   */
  getParamIndex(): number {
    return this.paramIndex;
  }

  /**
   * Build the final query.
   */
  build(): QueryResult {
    return {
      query: this.parts.join(' '),
      values: this.values,
    };
  }

  /**
   * Get current values array (for combining with other queries).
   */
  getValues(): any[] {
    return this.values;
  }
}
