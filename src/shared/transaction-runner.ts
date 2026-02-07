/**
 * Transaction Runner Utility
 *
 * Provides reusable transaction wrappers that eliminate boilerplate
 * try/catch/finally blocks across repository and service files.
 *
 * Works alongside src/shared/locks.ts for lock-aware transactions.
 * Integrates with DomainEventBus to ensure events are only dispatched
 * after successful transaction commit.
 */

import type { Pool, PoolClient } from 'pg';
import { getLockId, LockDomain, type LockSpec } from './locks';
import { tryGetEventBus } from './events';

/**
 * Pool interface for dependency injection.
 */
export interface PoolLike {
  connect(): Promise<PoolClient>;
}

/**
 * Run a function within a database transaction.
 * Handles connect, BEGIN, COMMIT/ROLLBACK, and release automatically.
 *
 * @param pool - PostgreSQL pool
 * @param fn - Async function receiving the client, to execute within transaction
 * @returns Result of the callback function
 *
 * @example
 * const result = await runInTransaction(pool, async (client) => {
 *   await client.query('INSERT INTO users (name) VALUES ($1)', ['Alice']);
 *   await client.query('INSERT INTO profiles (user_id) VALUES (lastval())');
 *   return { success: true };
 * });
 */
export async function runInTransaction<T>(
  pool: PoolLike,
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  const eventBus = tryGetEventBus();
  try {
    await client.query('BEGIN');
    eventBus?.beginTransaction();
    const result = await fn(client);
    await client.query('COMMIT');
    eventBus?.commitTransaction();
    return result;
  } catch (error) {
    eventBus?.rollbackTransaction();
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Run a function within a transaction with an advisory lock.
 * Acquires the lock after BEGIN, ensuring it's held for the transaction duration.
 *
 * @param pool - PostgreSQL pool
 * @param domain - Lock domain from LockDomain enum
 * @param id - Entity ID to lock
 * @param fn - Async function receiving the client, to execute within transaction
 * @returns Result of the callback function
 *
 * @example
 * const result = await runWithLock(pool, LockDomain.LEAGUE, leagueId, async (client) => {
 *   const roster = await client.query('SELECT * FROM rosters WHERE league_id = $1 FOR UPDATE', [leagueId]);
 *   // Safe from concurrent modifications
 *   return roster.rows[0];
 * });
 */
export async function runWithLock<T>(
  pool: PoolLike,
  domain: LockDomain,
  id: number,
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  const eventBus = tryGetEventBus();
  try {
    await client.query('BEGIN');
    eventBus?.beginTransaction();
    await client.query('SELECT pg_advisory_xact_lock($1)', [getLockId(domain, id)]);
    const result = await fn(client);
    await client.query('COMMIT');
    eventBus?.commitTransaction();
    return result;
  } catch (error) {
    eventBus?.rollbackTransaction();
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Run a function within a transaction with multiple advisory locks.
 * Locks are acquired in consistent order (by domain priority, then ID) to prevent deadlocks.
 *
 * @param pool - PostgreSQL pool
 * @param locks - Array of lock specifications
 * @param fn - Async function receiving the client, to execute within transaction
 * @returns Result of the callback function
 *
 * @example
 * const result = await runWithLocks(pool, [
 *   { domain: LockDomain.ROSTER, id: roster1Id },
 *   { domain: LockDomain.ROSTER, id: roster2Id },
 * ], async (client) => {
 *   // Transfer player between rosters
 *   await client.query('UPDATE roster_players SET roster_id = $1 WHERE id = $2', [roster2Id, playerId]);
 *   return { transferred: true };
 * });
 */
export async function runWithLocks<T>(
  pool: PoolLike,
  locks: LockSpec[],
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  const eventBus = tryGetEventBus();
  try {
    await client.query('BEGIN');
    eventBus?.beginTransaction();

    // Sort locks by domain priority (lower = first), then by ID
    const sortedLocks = [...locks].sort((a, b) => {
      if (a.domain !== b.domain) {
        return a.domain - b.domain;
      }
      return a.id - b.id;
    });

    // Acquire all locks in order
    for (const lock of sortedLocks) {
      const lockId = getLockId(lock.domain, lock.id);
      await client.query('SELECT pg_advisory_xact_lock($1)', [lockId]);
    }

    const result = await fn(client);
    await client.query('COMMIT');
    eventBus?.commitTransaction();
    return result;
  } catch (error) {
    eventBus?.rollbackTransaction();
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Transaction options for advanced use cases.
 */
export interface TransactionOptions {
  /** Lock to acquire after BEGIN */
  lock?: { domain: LockDomain; id: number };
  /** Multiple locks to acquire (sorted automatically) */
  locks?: LockSpec[];
  /** Isolation level (defaults to READ COMMITTED) */
  isolationLevel?: 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE';
}

/**
 * Advanced transaction runner with configurable options.
 * Use this when you need custom isolation levels or optional locking.
 *
 * @param pool - PostgreSQL pool
 * @param options - Transaction options
 * @param fn - Async function receiving the client, to execute within transaction
 * @returns Result of the callback function
 *
 * @example
 * const result = await runTransaction(pool, {
 *   lock: { domain: LockDomain.DRAFT, id: draftId },
 *   isolationLevel: 'SERIALIZABLE',
 * }, async (client) => {
 *   // Serializable transaction with draft lock
 *   return await makeAtomicPick(client, draftId, playerId);
 * });
 */
export async function runTransaction<T>(
  pool: PoolLike,
  options: TransactionOptions,
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  const eventBus = tryGetEventBus();
  try {
    // Start transaction with optional isolation level
    if (options.isolationLevel) {
      await client.query(`BEGIN ISOLATION LEVEL ${options.isolationLevel}`);
    } else {
      await client.query('BEGIN');
    }
    eventBus?.beginTransaction();

    // Acquire locks if specified
    if (options.locks && options.locks.length > 0) {
      const sortedLocks = [...options.locks].sort((a, b) => {
        if (a.domain !== b.domain) {
          return a.domain - b.domain;
        }
        return a.id - b.id;
      });
      for (const lock of sortedLocks) {
        const lockId = getLockId(lock.domain, lock.id);
        await client.query('SELECT pg_advisory_xact_lock($1)', [lockId]);
      }
    } else if (options.lock) {
      const lockId = getLockId(options.lock.domain, options.lock.id);
      await client.query('SELECT pg_advisory_xact_lock($1)', [lockId]);
    }

    const result = await fn(client);
    await client.query('COMMIT');
    eventBus?.commitTransaction();
    return result;
  } catch (error) {
    eventBus?.rollbackTransaction();
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Execute a read-only operation with a client from the pool.
 * Does not start a transaction - use for simple reads where atomicity isn't needed.
 *
 * @param pool - PostgreSQL pool
 * @param fn - Async function receiving the client
 * @returns Result of the callback function
 *
 * @example
 * const users = await withClient(pool, async (client) => {
 *   const result = await client.query('SELECT * FROM users WHERE active = true');
 *   return result.rows;
 * });
 */
export async function withClient<T>(
  pool: PoolLike,
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

// Re-export LockDomain for convenience
export { LockDomain } from './locks';
