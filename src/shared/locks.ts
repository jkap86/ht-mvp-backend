/**
 * Centralized Advisory Lock Helper
 *
 * Provides consistent lock ordering across the backend to prevent deadlocks.
 * Uses PostgreSQL advisory locks with deterministic ordering.
 *
 * Lock Ordering Priority (always acquire in this order):
 * 1. LEAGUE - League-level operations
 * 2. ROSTER - Roster-level operations (sorted by id)
 * 3. TRADE - Trade operations
 * 4. WAIVER - Waiver claim operations
 * 5. AUCTION - Auction lot operations
 * 6. LINEUP - Lineup operations
 *
 * Usage:
 *   await withLocks(client, [
 *     { domain: LockDomain.LEAGUE, id: leagueId },
 *     { domain: LockDomain.ROSTER, id: rosterId1 },
 *     { domain: LockDomain.ROSTER, id: rosterId2 },
 *   ], async () => {
 *     // Your transactional code here
 *   });
 *
 * ============================================================================
 * EXISTING pg_advisory_lock USAGE IN CODEBASE (for future refactoring)
 * ============================================================================
 *
 * The following files currently use pg_advisory_lock directly and should be
 * migrated to use this centralized helper for consistent lock ordering:
 *
 * DRAFT OPERATIONS (MIGRATED to LockDomain.DRAFT):
 * - src/modules/drafts/drafts.repository.ts - ✓ migrated
 * - src/engines/base-draft.engine.ts - ✓ migrated
 * - src/modules/drafts/auction/fast-auction.service.ts - ✓ migrated
 * - src/modules/drafts/auction/slow-auction.service.ts - ✓ migrated
 *
 * TRADE OPERATIONS (pending migration - uses getTradeLockId from src/utils/locks.ts):
 * - src/modules/trades/use-cases/propose-trade.use-case.ts: locks league for trade proposal
 * - src/modules/trades/use-cases/accept-trade.use-case.ts: locks league for trade acceptance
 * - src/modules/trades/use-cases/reject-trade.use-case.ts: locks league for trade rejection
 * - src/modules/trades/use-cases/cancel-trade.use-case.ts: locks league for trade cancellation
 * - src/modules/trades/use-cases/counter-trade.use-case.ts: locks league for counter-offers
 * - src/modules/trades/use-cases/process-trades.use-case.ts: locks league for trade processing
 *
 * WAIVER OPERATIONS (MIGRATED to LockDomain.WAIVER):
 * - src/modules/waivers/use-cases/process-waivers.use-case.ts: locks league for waiver processing
 * - src/modules/waivers/use-cases/submit-claim.use-case.ts: ✓ migrated
 *
 * ROSTER OPERATIONS (pending migration - direct lock IDs):
 * - src/modules/leagues/roster.service.ts
 *   - joinLeague(): locks league (using raw leagueId) for concurrent join prevention
 *   - kickMember(): locks roster (using rosterId + 1000000 offset) for member removal
 * - src/modules/rosters/rosters.service.ts
 *   - addPlayer(): locks league for free agent claims
 *   - dropPlayer(): locks league for player drops
 *   - addDropPlayer(): locks league for add/drop transactions
 *
 * AUCTION OPERATIONS (MIGRATED to LockDomain.ROSTER):
 * - src/modules/drafts/auction/fast-auction.service.ts - ✓ migrated
 *   - placeBid(): locks roster for bid placement
 * - src/modules/drafts/auction/slow-auction.service.ts - ✓ migrated
 *   - placeBid(): locks roster using LockDomain.ROSTER
 *   - settleLot(): locks winner's roster for settlement
 *
 * JOB-LEVEL LOCKS (session-level locks, not transaction-level):
 * - src/jobs/autopick.job.ts: AUTOPICK_LOCK_ID = 999999001
 * - src/jobs/waiver-processing.job.ts: WAIVER_PROCESSING_LOCK_ID = 999999002
 * - src/jobs/trade-expiration.job.ts: TRADE_EXPIRATION_LOCK_ID = 999999003
 * - src/jobs/slow-auction.job.ts: SLOW_AUCTION_LOCK_ID = 999999004
 *
 * NOTE: The legacy src/utils/locks.ts uses 1M-5M namespace offsets.
 * This modern helper (src/shared/locks.ts) uses 100M-900M offsets.
 * All new code should use this helper to prevent lock ID collisions.
 * ============================================================================
 */

import type { PoolClient } from 'pg';
import { logger } from '../config/logger.config';
import { LockTimeoutError } from '../utils/exceptions';
import { tryGetEventBus } from './events';

/**
 * Lock domain enum with priority values.
 * Lower number = higher priority = acquired first.
 */
export enum LockDomain {
  LEAGUE = 1,
  ROSTER = 2,
  TRADE = 3,
  WAIVER = 4,
  AUCTION = 5,
  LINEUP = 6,
  DRAFT = 7,
  JOB = 9,
}

/**
 * Lock specification for acquiring an advisory lock.
 */
export interface LockSpec {
  domain: LockDomain;
  id: number;
}

/**
 * Namespace offsets to prevent lock ID collisions between domains.
 * Each domain gets 100 million IDs.
 */
const LOCK_NAMESPACE_OFFSET: Record<LockDomain, number> = {
  [LockDomain.LEAGUE]: 100_000_000,
  [LockDomain.ROSTER]: 200_000_000,
  [LockDomain.TRADE]: 300_000_000,
  [LockDomain.WAIVER]: 400_000_000,
  [LockDomain.AUCTION]: 500_000_000,
  [LockDomain.LINEUP]: 600_000_000,
  [LockDomain.DRAFT]: 700_000_000,
  [LockDomain.JOB]: 900_000_000,
};

/**
 * Generates a deterministic lock ID from domain and entity ID.
 * Uses namespace offset + entity ID to avoid collisions.
 */
export function getLockId(domain: LockDomain, id: number): number {
  return LOCK_NAMESPACE_OFFSET[domain] + id;
}

/**
 * Sorts locks by domain priority, then by entity ID.
 * This ensures consistent ordering to prevent deadlocks.
 */
function sortLocks(locks: LockSpec[]): LockSpec[] {
  return [...locks].sort((a, b) => {
    // First sort by domain priority (lower = first)
    if (a.domain !== b.domain) {
      return a.domain - b.domain;
    }
    // Then sort by ID (lower = first)
    return a.id - b.id;
  });
}

/**
 * Default threshold for slow lock detection (5 seconds).
 */
const DEFAULT_SLOW_LOCK_THRESHOLD_MS = 5000;

/**
 * Default timeout for lock acquisition (30 seconds).
 * Uses SET LOCAL statement_timeout to prevent indefinite blocking.
 */
const DEFAULT_LOCK_TIMEOUT_MS = 30_000;

/**
 * PostgreSQL error code for statement cancellation due to statement_timeout.
 */
const PG_STATEMENT_TIMEOUT_ERROR_CODE = '57014';

/**
 * Options for lock acquisition.
 */
export interface LockOptions {
  /** Threshold in ms before logging a slow lock warning (default: 5000ms) */
  slowThresholdMs?: number;
  /** Timeout in ms for lock acquisition. If the lock isn't acquired within this time,
   *  a LockTimeoutError is thrown. Set to 0 for no timeout. (default: 30000ms) */
  timeoutMs?: number;
}

/**
 * Acquires multiple advisory locks in consistent order and executes the callback.
 * Uses pg_advisory_xact_lock for transactional locks (auto-released on commit/rollback).
 *
 * Logs a warning if any lock acquisition takes longer than the slow threshold (default 5s).
 *
 * @param client - PostgreSQL pool client (must be in a transaction)
 * @param locks - Array of lock specifications to acquire
 * @param fn - Async function to execute while holding locks
 * @param options - Optional configuration for lock behavior
 * @returns Result of the callback function
 *
 * @example
 * await withLocks(client, [
 *   { domain: LockDomain.ROSTER, id: 5 },
 *   { domain: LockDomain.ROSTER, id: 3 },
 * ], async () => {
 *   // Locks acquired in order: ROSTER(3), ROSTER(5)
 *   await performOperation();
 * });
 */
export async function withLocks<T>(
  client: PoolClient,
  locks: LockSpec[],
  fn: () => Promise<T>,
  options?: LockOptions
): Promise<T> {
  // Sort locks to ensure consistent ordering
  const sortedLocks = sortLocks(locks);
  const slowThreshold = options?.slowThresholdMs ?? DEFAULT_SLOW_LOCK_THRESHOLD_MS;
  const lockTimeoutMs = options?.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;

  // Acquire all locks in order
  for (const lock of sortedLocks) {
    const lockId = getLockId(lock.domain, lock.id);
    const start = Date.now();

    // Set statement timeout to prevent indefinite blocking during lock acquisition
    if (lockTimeoutMs > 0) {
      await client.query(`SET LOCAL statement_timeout = ${lockTimeoutMs}`);
    }
    try {
      await client.query('SELECT pg_advisory_xact_lock($1)', [lockId]);
    } catch (err: unknown) {
      // Check if this is a statement timeout (PG error code 57014)
      const pgError = err as { code?: string };
      if (pgError.code === PG_STATEMENT_TIMEOUT_ERROR_CODE) {
        throw new LockTimeoutError(
          lockId,
          lockTimeoutMs,
          `Failed to acquire lock: domain=${LockDomain[lock.domain]} id=${lock.id} lockId=${lockId} within ${lockTimeoutMs}ms`
        );
      }
      throw err;
    } finally {
      // Reset statement timeout so the callback runs without artificial time limits
      if (lockTimeoutMs > 0) {
        await client.query('SET LOCAL statement_timeout = 0');
      }
    }

    const elapsed = Date.now() - start;
    if (elapsed > slowThreshold) {
      logger.warn(
        `Slow lock acquisition: domain=${LockDomain[lock.domain]} id=${lock.id} lockId=${lockId} took ${elapsed}ms`
      );
    }
  }

  // Execute the callback
  return fn();
}

/**
 * Helper: Lock a single league.
 */
export async function lockLeague<T>(
  client: PoolClient,
  leagueId: number,
  fn: () => Promise<T>
): Promise<T> {
  return withLocks(client, [{ domain: LockDomain.LEAGUE, id: leagueId }], fn);
}

/**
 * Helper: Lock a single roster.
 */
export async function lockRoster<T>(
  client: PoolClient,
  rosterId: number,
  fn: () => Promise<T>
): Promise<T> {
  return withLocks(client, [{ domain: LockDomain.ROSTER, id: rosterId }], fn);
}

/**
 * Helper: Lock multiple rosters (sorted automatically).
 */
export async function lockRosters<T>(
  client: PoolClient,
  rosterIds: number[],
  fn: () => Promise<T>
): Promise<T> {
  const locks = rosterIds.map((id) => ({ domain: LockDomain.ROSTER, id }));
  return withLocks(client, locks, fn);
}

/**
 * Helper: Lock a trade (uses league-scoped locking).
 */
export async function lockTrade<T>(
  client: PoolClient,
  leagueId: number,
  fn: () => Promise<T>
): Promise<T> {
  return withLocks(client, [{ domain: LockDomain.TRADE, id: leagueId }], fn);
}

/**
 * Helper: Lock waiver operations for a league.
 */
export async function lockWaiver<T>(
  client: PoolClient,
  leagueId: number,
  fn: () => Promise<T>
): Promise<T> {
  return withLocks(client, [{ domain: LockDomain.WAIVER, id: leagueId }], fn);
}

/**
 * Helper: Lock an auction lot.
 */
export async function lockAuction<T>(
  client: PoolClient,
  lotId: number,
  fn: () => Promise<T>
): Promise<T> {
  return withLocks(client, [{ domain: LockDomain.AUCTION, id: lotId }], fn);
}

/**
 * Helper: Lock a lineup.
 */
export async function lockLineup<T>(
  client: PoolClient,
  lineupId: number,
  fn: () => Promise<T>
): Promise<T> {
  return withLocks(client, [{ domain: LockDomain.LINEUP, id: lineupId }], fn);
}

/**
 * Helper: Lock a draft.
 */
export async function lockDraft<T>(
  client: PoolClient,
  draftId: number,
  fn: () => Promise<T>
): Promise<T> {
  return withLocks(client, [{ domain: LockDomain.DRAFT, id: draftId }], fn);
}

/**
 * Helper: Acquire a job-level lock (for singleton jobs like autopick, waiver processing).
 * Uses session-level advisory lock (not transaction-level) for long-running jobs.
 */
export async function lockJob<T>(
  client: PoolClient,
  jobId: number,
  fn: () => Promise<T>
): Promise<T> {
  return withLocks(client, [{ domain: LockDomain.JOB, id: jobId }], fn);
}

/**
 * Run a function within a draft transaction with advisory lock.
 * Acquires lock, begins transaction, executes function, commits or rolls back.
 *
 * Logs a warning if lock acquisition takes longer than the slow threshold (default 5s).
 *
 * @param pool - PostgreSQL pool
 * @param draftId - Draft to lock
 * @param fn - Async function receiving the client, to execute within transaction
 * @param options - Optional configuration for lock behavior
 * @returns Result of the callback function
 */
export async function runInDraftTransaction<T>(
  pool: { connect: () => Promise<PoolClient> },
  draftId: number,
  fn: (client: PoolClient) => Promise<T>,
  options?: LockOptions
): Promise<T> {
  const client = await pool.connect();
  const slowThreshold = options?.slowThresholdMs ?? DEFAULT_SLOW_LOCK_THRESHOLD_MS;
  const eventBus = tryGetEventBus();

  try {
    await client.query('BEGIN');
    eventBus?.beginTransaction();

    const lockId = getLockId(LockDomain.DRAFT, draftId);
    const lockTimeoutMs = options?.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    const start = Date.now();

    // Set statement timeout to prevent indefinite blocking during lock acquisition
    if (lockTimeoutMs > 0) {
      await client.query(`SET LOCAL statement_timeout = ${lockTimeoutMs}`);
    }
    try {
      await client.query('SELECT pg_advisory_xact_lock($1)', [lockId]);
    } catch (err: unknown) {
      const pgError = err as { code?: string };
      if (pgError.code === PG_STATEMENT_TIMEOUT_ERROR_CODE) {
        throw new LockTimeoutError(
          lockId,
          lockTimeoutMs,
          `Failed to acquire draft lock: draftId=${draftId} lockId=${lockId} within ${lockTimeoutMs}ms`
        );
      }
      throw err;
    } finally {
      // Reset statement timeout so the callback runs without artificial time limits
      if (lockTimeoutMs > 0) {
        await client.query('SET LOCAL statement_timeout = 0');
      }
    }

    const elapsed = Date.now() - start;
    if (elapsed > slowThreshold) {
      logger.warn(
        `Slow lock acquisition: domain=DRAFT draftId=${draftId} lockId=${lockId} took ${elapsed}ms`
      );
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
 * Lock helper service for dependency injection.
 */
export class LockHelper {
  /**
   * Acquire multiple locks in consistent order.
   */
  async withLocks<T>(client: PoolClient, locks: LockSpec[], fn: () => Promise<T>): Promise<T> {
    return withLocks(client, locks, fn);
  }

  /**
   * Lock a league.
   */
  async lockLeague<T>(client: PoolClient, leagueId: number, fn: () => Promise<T>): Promise<T> {
    return lockLeague(client, leagueId, fn);
  }

  /**
   * Lock a roster.
   */
  async lockRoster<T>(client: PoolClient, rosterId: number, fn: () => Promise<T>): Promise<T> {
    return lockRoster(client, rosterId, fn);
  }

  /**
   * Lock multiple rosters.
   */
  async lockRosters<T>(client: PoolClient, rosterIds: number[], fn: () => Promise<T>): Promise<T> {
    return lockRosters(client, rosterIds, fn);
  }

  /**
   * Lock trade operations for a league.
   */
  async lockTrade<T>(client: PoolClient, leagueId: number, fn: () => Promise<T>): Promise<T> {
    return lockTrade(client, leagueId, fn);
  }

  /**
   * Lock waiver operations for a league.
   */
  async lockWaiver<T>(client: PoolClient, leagueId: number, fn: () => Promise<T>): Promise<T> {
    return lockWaiver(client, leagueId, fn);
  }

  /**
   * Lock an auction lot.
   */
  async lockAuction<T>(client: PoolClient, lotId: number, fn: () => Promise<T>): Promise<T> {
    return lockAuction(client, lotId, fn);
  }

  /**
   * Lock a lineup.
   */
  async lockLineup<T>(client: PoolClient, lineupId: number, fn: () => Promise<T>): Promise<T> {
    return lockLineup(client, lineupId, fn);
  }

  /**
   * Lock a draft.
   */
  async lockDraft<T>(client: PoolClient, draftId: number, fn: () => Promise<T>): Promise<T> {
    return lockDraft(client, draftId, fn);
  }

  /**
   * Lock a job.
   */
  async lockJob<T>(client: PoolClient, jobId: number, fn: () => Promise<T>): Promise<T> {
    return lockJob(client, jobId, fn);
  }
}
