/**
 * Query Context - AsyncLocalStorage for request/job context propagation
 *
 * This module provides context propagation for database queries using AsyncLocalStorage.
 * It enables slow query logging to include information about which request or job
 * initiated the query, without passing context through every function call.
 *
 * Usage:
 * ```typescript
 * // In middleware (automatic for HTTP requests)
 * await withQueryContext({ requestId, userId }, async () => {
 *   await someService.doWork(); // All queries inherit context
 * });
 *
 * // In jobs
 * await withQueryContext({ jobName: 'waiver-processing' }, async () => {
 *   await processWaivers();
 * });
 *
 * // Manual label for specific operations
 * setQueryLabel('findActiveDrafts');
 * await draftRepo.findActive();
 * ```
 */

import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Context attached to database queries for logging and tracing.
 */
export interface QueryContext {
  /** Unique request ID for HTTP requests */
  requestId?: string;
  /** Authenticated user ID (if any) */
  userId?: string;
  /** Background job name (if running in a job) */
  jobName?: string;
  /** Custom label for the current query/operation */
  label?: string;
  /** Timestamp when the context was created */
  startedAt?: number;
}

/**
 * AsyncLocalStorage instance for query context.
 * Safely propagates context across async boundaries.
 */
export const queryContextStorage = new AsyncLocalStorage<QueryContext>();

/**
 * Get the current query context (or empty object if none).
 */
export function getQueryContext(): QueryContext {
  return queryContextStorage.getStore() ?? {};
}

/**
 * Run a function with a query context.
 * All database queries within the callback will have access to this context.
 *
 * @param context - Context to attach to queries
 * @param fn - Function to execute within the context
 * @returns Result of the function
 *
 * @example
 * ```typescript
 * const result = await withQueryContext(
 *   { requestId: 'req-123', userId: 'user-456' },
 *   async () => {
 *     return await userService.findById(userId);
 *   }
 * );
 * ```
 */
export function withQueryContext<T>(context: QueryContext, fn: () => T): T {
  const fullContext: QueryContext = {
    ...context,
    startedAt: context.startedAt ?? Date.now(),
  };
  return queryContextStorage.run(fullContext, fn);
}

/**
 * Set a label for subsequent queries in the current context.
 * Useful for labeling specific database operations.
 *
 * @param label - Descriptive label for the operation
 *
 * @example
 * ```typescript
 * setQueryLabel('findExpiredDrafts');
 * const drafts = await draftRepo.findExpired();
 * ```
 */
export function setQueryLabel(label: string): void {
  const ctx = queryContextStorage.getStore();
  if (ctx) {
    ctx.label = label;
  }
}

/**
 * Clear the current query label (returns to context without label).
 */
export function clearQueryLabel(): void {
  const ctx = queryContextStorage.getStore();
  if (ctx) {
    ctx.label = undefined;
  }
}

/**
 * Check if currently running within a query context.
 */
export function hasQueryContext(): boolean {
  return queryContextStorage.getStore() !== undefined;
}

/**
 * Get a formatted string representation of the current context.
 * Useful for logging.
 */
export function formatQueryContext(): string {
  const ctx = getQueryContext();
  const parts: string[] = [];

  if (ctx.requestId) parts.push(`req=${ctx.requestId}`);
  if (ctx.userId) parts.push(`user=${ctx.userId}`);
  if (ctx.jobName) parts.push(`job=${ctx.jobName}`);
  if (ctx.label) parts.push(`label=${ctx.label}`);

  return parts.length > 0 ? parts.join(', ') : 'no-context';
}

/**
 * Create a context object for HTTP requests.
 * Helper for use in request middleware.
 */
export function createRequestContext(requestId: string, userId?: string): QueryContext {
  return {
    requestId,
    userId,
    startedAt: Date.now(),
  };
}

/**
 * Create a context object for background jobs.
 * Helper for use in job runners.
 */
export function createJobContext(jobName: string): QueryContext {
  return {
    jobName,
    startedAt: Date.now(),
  };
}
