import { Pool, PoolClient } from 'pg';
import { logger } from '../config/logger.config';
import { getLockId, LockDomain } from './locks';

/**
 * Global advisory lock ID for job leader election.
 * Uses the unified JOB domain namespace (900_000_000+) with a high ID to avoid conflicts.
 */
const LEADER_LOCK_ID = getLockId(LockDomain.JOB, 999);

/**
 * LeaderLock provides distributed leader election using Postgres advisory locks.
 *
 * When running multiple backend instances, only one should execute background jobs
 * (stats sync, waiver processing, trade expiration, etc.) to prevent duplicate work.
 *
 * IMPORTANT: Session-level advisory locks (pg_try_advisory_lock / pg_advisory_unlock)
 * are tied to the specific database CONNECTION. This class uses a dedicated client
 * from the pool for the entire acquire -> callback -> release lifecycle to ensure
 * the lock is always acquired and released on the same connection.
 *
 * Usage:
 * ```typescript
 * const result = await leaderLock.runAsLeader(async () => {
 *   // Job logic here - only runs if this instance is the leader
 * });
 *
 * if (result === null) {
 *   logger.debug('Not leader, skipping job');
 * }
 * ```
 */
export class LeaderLock {
  constructor(private readonly db: Pool) {}

  /**
   * Try to acquire leader lock (non-blocking) on the given client.
   * Returns true if this instance acquired the lock and is now the leader.
   * Returns false if another instance already holds the lock.
   *
   * @param client - Dedicated pool client to acquire the lock on
   */
  private async tryAcquire(client: PoolClient): Promise<boolean> {
    try {
      const result = await client.query(
        'SELECT pg_try_advisory_lock($1) as acquired',
        [LEADER_LOCK_ID]
      );
      return result.rows[0].acquired;
    } catch (error) {
      logger.error(`Failed to acquire leader lock: ${error}`);
      return false;
    }
  }

  /**
   * Release the leader lock on the given client.
   * Must be called on the SAME client that acquired the lock.
   *
   * @param client - The dedicated pool client that holds the lock
   */
  private async release(client: PoolClient): Promise<void> {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [LEADER_LOCK_ID]);
    } catch (error) {
      logger.error(`Failed to release leader lock: ${error}`);
    }
  }

  /**
   * Execute callback only if this instance can become the leader.
   *
   * Obtains a dedicated connection from the pool, acquires the session-level
   * advisory lock on that connection, executes the callback while holding both
   * the lock and the connection, then releases the lock and connection.
   *
   * @param callback - Function to execute if this instance is the leader
   * @returns The callback result, or null if not the leader
   */
  async runAsLeader<T>(callback: () => Promise<T>): Promise<T | null> {
    const client = await this.db.connect();

    try {
      const isLeader = await this.tryAcquire(client);
      if (!isLeader) {
        return null;
      }

      try {
        return await callback();
      } finally {
        await this.release(client);
      }
    } finally {
      client.release();
    }
  }
}
