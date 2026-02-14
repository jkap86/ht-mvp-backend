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
import { logger } from '../config/logger.config';

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

  const execute = async () => {
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      eventBus?.commitTransaction();
      return result;
    } catch (error) {
      eventBus?.rollbackTransaction();
      await client.query('ROLLBACK');
      throw error;
    }
  };

  try {
    return eventBus
      ? await eventBus.runInTransaction(execute)
      : await execute();
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

  const execute = async () => {
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [getLockId(domain, id)]);
      const result = await fn(client);
      await client.query('COMMIT');
      eventBus?.commitTransaction();
      return result;
    } catch (error) {
      eventBus?.rollbackTransaction();
      await client.query('ROLLBACK');
      throw error;
    }
  };

  try {
    return eventBus
      ? await eventBus.runInTransaction(execute)
      : await execute();
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

  const execute = async () => {
    try {
      await client.query('BEGIN');

      // Sort locks by domain priority (lower = first), then by ID
      const sortedLocks = [...locks].sort((a, b) => {
        if (a.domain !== b.domain) {
          return a.domain - b.domain;
        }
        return a.id - b.id;
      });

      // Remove duplicates (same domain and ID)
      const uniqueLocks = sortedLocks.filter(
        (lock, i, arr) =>
          i === 0 ||
          lock.domain !== arr[i - 1].domain ||
          lock.id !== arr[i - 1].id
      );

      // Development validation: warn if original order wasn't optimal
      if (process.env.NODE_ENV === 'development' && locks.length > 1) {
        let isOptimal = true;
        for (let i = 1; i < locks.length; i++) {
          const prev = locks[i - 1];
          const curr = locks[i];
          if (
            prev.domain > curr.domain ||
            (prev.domain === curr.domain && prev.id > curr.id)
          ) {
            isOptimal = false;
            break;
          }
        }
        if (!isOptimal) {
          logger.warn('Locks not in optimal order - they have been sorted to prevent deadlocks', {
            originalOrder: locks.map(l => ({ domain: l.domain, id: l.id })),
            sortedOrder: uniqueLocks.map(l => ({ domain: l.domain, id: l.id })),
          });
        }
      }

      // Acquire all locks in order
      for (const lock of uniqueLocks) {
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
    }
  };

  try {
    return eventBus
      ? await eventBus.runInTransaction(execute)
      : await execute();
  } finally {
    client.release();
  }
}

/**
 * Run a function within a transaction with a try-lock (non-blocking).
 * Returns `null` if the lock is already held (skip), otherwise returns the result.
 * Uses pg_try_advisory_xact_lock which is released on COMMIT/ROLLBACK.
 *
 * @param pool - PostgreSQL pool
 * @param domain - Lock domain from LockDomain enum
 * @param id - Entity ID to lock
 * @param fn - Async function receiving the client, to execute within transaction
 * @returns Result of the callback, or null if lock was not acquired
 *
 * @example
 * const result = await runWithTryLock(pool, LockDomain.LIVE_SCORING_ACTUAL, compositeId, async (client) => {
 *   await updateScores(client, leagueId, week);
 *   return { updated: true };
 * });
 * if (result === null) {
 *   logger.debug('Skipped: lock held by another process');
 * }
 */
export async function runWithTryLock<T>(
  pool: PoolLike,
  domain: LockDomain,
  id: number,
  fn: (client: PoolClient) => Promise<T>
): Promise<T | null> {
  const client = await pool.connect();
  const eventBus = tryGetEventBus();

  const execute = async () => {
    try {
      await client.query('BEGIN');

      const lockId = getLockId(domain, id);
      const lockResult = await client.query<{ pg_try_advisory_xact_lock: boolean }>(
        'SELECT pg_try_advisory_xact_lock($1) AS pg_try_advisory_xact_lock',
        [lockId]
      );

      if (!lockResult.rows[0].pg_try_advisory_xact_lock) {
        await client.query('ROLLBACK');
        return null;
      }

      const result = await fn(client);
      await client.query('COMMIT');
      eventBus?.commitTransaction();
      return result;
    } catch (error) {
      eventBus?.rollbackTransaction();
      await client.query('ROLLBACK');
      throw error;
    }
  };

  try {
    return eventBus
      ? await eventBus.runInTransaction(execute)
      : await execute();
  } finally {
    client.release();
  }
}

/**
 * Valid PostgreSQL isolation levels for runtime validation.
 * TypeScript types are erased at runtime, so we need a runtime check too.
 */
const VALID_ISOLATION_LEVELS = ['READ COMMITTED', 'REPEATABLE READ', 'SERIALIZABLE'] as const;

/**
 * Transaction options for advanced use cases.
 */
export interface TransactionOptions {
  /** Lock to acquire after BEGIN */
  lock?: { domain: LockDomain; id: number };
  /** Multiple locks to acquire (sorted automatically) */
  locks?: LockSpec[];
  /** Isolation level (defaults to READ COMMITTED) */
  isolationLevel?: (typeof VALID_ISOLATION_LEVELS)[number];
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

  const execute = async () => {
    try {
      // Start transaction with optional isolation level
      if (options.isolationLevel) {
        if (!VALID_ISOLATION_LEVELS.includes(options.isolationLevel)) {
          throw new Error(`Invalid isolation level: ${options.isolationLevel}`);
        }
        await client.query(`BEGIN ISOLATION LEVEL ${options.isolationLevel}`);
      } else {
        await client.query('BEGIN');
      }

      // Acquire locks if specified
      if (options.locks && options.locks.length > 0) {
        const sortedLocks = [...options.locks].sort((a, b) => {
          if (a.domain !== b.domain) {
            return a.domain - b.domain;
          }
          return a.id - b.id;
        });

        // Remove duplicates
        const uniqueLocks = sortedLocks.filter(
          (lock, i, arr) =>
            i === 0 ||
            lock.domain !== arr[i - 1].domain ||
            lock.id !== arr[i - 1].id
        );

        // Development validation
        if (process.env.NODE_ENV === 'development' && options.locks.length > 1) {
          let isOptimal = true;
          for (let i = 1; i < options.locks.length; i++) {
            const prev = options.locks[i - 1];
            const curr = options.locks[i];
            if (
              prev.domain > curr.domain ||
              (prev.domain === curr.domain && prev.id > curr.id)
            ) {
              isOptimal = false;
              break;
            }
          }
          if (!isOptimal) {
            logger.warn('Locks not in optimal order - they have been sorted to prevent deadlocks', {
              originalOrder: options.locks.map(l => ({ domain: l.domain, id: l.id })),
              sortedOrder: uniqueLocks.map(l => ({ domain: l.domain, id: l.id })),
            });
          }
        }

        for (const lock of uniqueLocks) {
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
    }
  };

  try {
    return eventBus
      ? await eventBus.runInTransaction(execute)
      : await execute();
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
