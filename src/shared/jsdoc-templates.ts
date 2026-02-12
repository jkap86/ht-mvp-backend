/**
 * JSDoc Templates for Common Patterns
 *
 * This file contains reusable JSDoc comment templates to ensure consistency
 * across the codebase. Copy and paste these templates into your code.
 */

/**
 * Template for repository methods that accept optional PoolClient parameter.
 *
 * Usage: Copy this JSDoc block and customize the method description, parameters, and return type.
 *
 * @example
 * ```typescript
 * // Copy this template:
 * /**
 *  * Find entity by ID.
 *  *
 *  * @param id - Entity ID
 *  * @param client - Optional client for use within transactions.
 *  *                 **WARNING: Caller MUST ensure connection release via try/finally.**
 *  *                 Prefer using transaction helpers (runInTransaction, runWithLock) instead.
 *  * @returns Entity or null if not found
 *  *
 *  * @example
 *  * // PREFERRED: Use transaction helpers
 *  * await runInTransaction(pool, async (client) => {
 *  *   const entity = await repo.findById(id, client);
 *  *   await repo.update(entity.id, changes, client);
 *  * });
 *  *
 *  * @example
 *  * // ACCEPTABLE: Single read without transaction
 *  * const entity = await repo.findById(id); // Uses pool internally
 *  *
 *  * @example
 *  * // AVOID: Manual client management (error-prone)
 *  * const client = await pool.connect();
 *  * try {
 *  *   const entity = await repo.findById(id, client);
 *  * } finally {
 *  *   client.release(); // Easy to forget in complex error paths
 *  * }
 *  *\/
 * async findById(id: number, client?: PoolClient): Promise<Entity | null> {
 *   // Implementation...
 * }
 * ```
 */
export const REPO_METHOD_WITH_OPTIONAL_CLIENT_JSDOC = `
/**
 * [Method description]
 *
 * @param [paramName] - [Parameter description]
 * @param client - Optional client for use within transactions.
 *                 **WARNING: Caller MUST ensure connection release via try/finally.**
 *                 Prefer using transaction helpers (runInTransaction, runWithLock) instead.
 * @returns [Return value description]
 *
 * @example
 * // PREFERRED: Use transaction helpers
 * await runInTransaction(pool, async (client) => {
 *   const result = await repo.method(args, client);
 *   await repo.anotherMethod(result.id, client);
 * });
 *
 * @example
 * // ACCEPTABLE: Single read without transaction
 * const result = await repo.method(args); // Uses pool internally
 *
 * @example
 * // AVOID: Manual client management (error-prone)
 * const client = await pool.connect();
 * try {
 *   const result = await repo.method(args, client);
 * } finally {
 *   client.release(); // Easy to forget in complex error paths
 * }
 */
`;

/**
 * Template for transaction wrapper functions.
 *
 * @example
 * ```typescript
 * /**
 *  * Process a trade with automatic connection and lock management.
 *  *
 *  * This function handles transaction lifecycle, connection release, and
 *  * lock acquisition automatically. Callers do not need to manage connections.
 *  *
 *  * @param tradeId - ID of the trade to process
 *  * @returns Processing result
 *  *
 *  * @example
 *  * // Safe: Connection managed automatically
 *  * const result = await processTrade(tradeId);
 *  *\/
 * async function processTrade(tradeId: number): Promise<ProcessResult> {
 *   return runWithLock(pool, LockDomain.TRADE, tradeId, async (client) => {
 *     // All operations here are transactional
 *     // Connection released automatically on success or error
 *   });
 * }
 * ```
 */
export const TRANSACTION_WRAPPER_FUNCTION_JSDOC = `
/**
 * [Function description]
 *
 * This function handles transaction lifecycle, connection release, and
 * lock acquisition automatically. Callers do not need to manage connections.
 *
 * @param [paramName] - [Parameter description]
 * @returns [Return value description]
 *
 * @example
 * // Safe: Connection managed automatically
 * const result = await functionName(args);
 */
`;

/**
 * Template for service methods that use transaction helpers internally.
 *
 * @example
 * ```typescript
 * /**
 *  * Add a player to a roster with validation and transaction management.
 *  *
 *  * This method internally uses transaction helpers to ensure atomic operations
 *  * and proper connection management. Callers do not need to pass a client.
 *  *
 *  * @param rosterId - ID of the roster
 *  * @param playerId - ID of the player to add
 *  * @returns Updated roster
 *  *
 *  * @throws ValidationException if roster is full or player is unavailable
 *  *
 *  * @example
 *  * const roster = await rosterService.addPlayer(rosterId, playerId);
 *  *\/
 * async addPlayer(rosterId: number, playerId: number): Promise<Roster> {
 *   return runWithLock(pool, LockDomain.ROSTER, rosterId, async (client) => {
 *     // Validation and operations
 *   });
 * }
 * ```
 */
export const SERVICE_METHOD_WITH_INTERNAL_TRANSACTION_JSDOC = `
/**
 * [Method description]
 *
 * This method internally uses transaction helpers to ensure atomic operations
 * and proper connection management. Callers do not need to pass a client.
 *
 * @param [paramName] - [Parameter description]
 * @returns [Return value description]
 *
 * @throws [ExceptionType] if [condition]
 *
 * @example
 * const result = await service.method(args);
 */
`;

/**
 * Migration guide for converting manual connection management to transaction helpers.
 */
export const MIGRATION_GUIDE = `
# Migrating Manual Connection Management to Transaction Helpers

## Before (Manual Management)
\`\`\`typescript
async function transferPlayer(fromRosterId: number, toRosterId: number, playerId: number) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Operation 1
    await client.query('DELETE FROM roster_players WHERE roster_id = $1 AND player_id = $2',
      [fromRosterId, playerId]);

    // Operation 2
    await client.query('INSERT INTO roster_players (roster_id, player_id) VALUES ($1, $2)',
      [toRosterId, playerId]);

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
\`\`\`

## After (Transaction Helper)
\`\`\`typescript
async function transferPlayer(fromRosterId: number, toRosterId: number, playerId: number) {
  await runWithLocks(pool, [
    { domain: LockDomain.ROSTER, id: Math.min(fromRosterId, toRosterId) },
    { domain: LockDomain.ROSTER, id: Math.max(fromRosterId, toRosterId) },
  ], async (client) => {
    // Operation 1
    await client.query('DELETE FROM roster_players WHERE roster_id = $1 AND player_id = $2',
      [fromRosterId, playerId]);

    // Operation 2
    await client.query('INSERT INTO roster_players (roster_id, player_id) VALUES ($1, $2)',
      [toRosterId, playerId]);

    // Connection, transaction, and locks all managed automatically
    // No need for explicit BEGIN/COMMIT/ROLLBACK/release
  });
}
\`\`\`

## Benefits
- ✅ Connection automatically released on success OR error
- ✅ Transaction automatically rolled back on error
- ✅ Locks automatically released with transaction
- ✅ No risk of forgetting finally block
- ✅ Cleaner, more readable code
- ✅ Consistent pattern across codebase
`;
