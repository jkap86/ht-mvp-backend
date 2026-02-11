import { Pool } from 'pg';
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
   * Try to acquire leader lock (non-blocking).
   * Returns true if this instance acquired the lock and is now the leader.
   * Returns false if another instance already holds the lock.
   */
  async tryAcquire(): Promise<boolean> {
    try {
      const result = await this.db.query(
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
   * Release the leader lock.
   * Should only be called by the instance that acquired the lock.
   */
  async release(): Promise<void> {
    try {
      await this.db.query('SELECT pg_advisory_unlock($1)', [LEADER_LOCK_ID]);
    } catch (error) {
      logger.error(`Failed to release leader lock: ${error}`);
    }
  }

  /**
   * Execute callback only if this instance can become the leader.
   *
   * @param callback - Function to execute if this instance is the leader
   * @returns The callback result, or null if not the leader
   */
  async runAsLeader<T>(callback: () => Promise<T>): Promise<T | null> {
    const isLeader = await this.tryAcquire();
    if (!isLeader) {
      return null;
    }

    try {
      return await callback();
    } finally {
      await this.release();
    }
  }
}
