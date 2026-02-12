# Developer Guidelines: Database Connection Management

## Critical: Prevent Connection Pool Leaks

Database connection leaks are a **HIGH SEVERITY** issue that can cause production outages. This guide provides mandatory patterns for safe connection management.

---

## The Problem

When connections are not properly released back to the pool:
- **Connection Exhaustion**: New requests timeout waiting for connections
- **Cascading Failures**: Entire API becomes unresponsive
- **Production Outage**: Requires server restart to recover

---

## Mandatory Pattern: Use Transaction Helpers

**ALWAYS use transaction helpers instead of manual connection management:**

```typescript
import { runInTransaction, runWithLock, LockDomain } from '../shared/transaction-runner';

// ✅ CORRECT: Transaction helper manages connection lifecycle
await runInTransaction(pool, async (client) => {
  await repo.someMethod(client, args);
  await repo.anotherMethod(client, args);
  // Connection automatically released on success OR error
});

// ❌ WRONG: Manual connection management (leak-prone)
const client = await pool.connect();
try {
  await repo.someMethod(client, args);
  await repo.anotherMethod(client, args);
} catch (err) {
  throw err; // Connection leaked! Missing finally block
}
```

---

## Available Transaction Helpers

Located in `src/shared/transaction-runner.ts`:

### Basic Transactions

```typescript
// Simple transaction
await runInTransaction(pool, async (client) => {
  // Your transactional operations
});

// Read-only (no transaction)
await withClient(pool, async (client) => {
  return await repo.findById(id, client);
});
```

### Transactions with Locks

```typescript
// Single lock
await runWithLock(pool, LockDomain.ROSTER, rosterId, async (client) => {
  await repo.updateRoster(client, rosterId, changes);
});

// Multiple locks (auto-sorted to prevent deadlocks)
await runWithLocks(pool, [
  { domain: LockDomain.ROSTER, id: roster1Id },
  { domain: LockDomain.ROSTER, id: roster2Id },
], async (client) => {
  // Transfer players between rosters
});

// Advanced options
await runTransaction(pool, {
  lock: { domain: LockDomain.DRAFT, id: draftId },
  isolationLevel: 'SERIALIZABLE',
}, async (client) => {
  // Serializable transaction with lock
});
```

### Domain-Specific Helpers

```typescript
// Draft operations
await runInDraftTransaction(pool, draftId, async (client) => {
  await DraftRepository.makePickAndAdvanceTx(client, draftId, pick, newState);
});
```

---

## When Calling Repository Methods

Repository methods with `client?: PoolClient` parameter have caller responsibility:

```typescript
// ✅ PREFERRED: Use transaction helper
await runInTransaction(pool, async (client) => {
  const entity = await repo.findById(id, client);
  await repo.update(entity.id, changes, client);
});

// ✅ ACCEPTABLE: No transaction needed
const entity = await repo.findById(id); // Uses pool internally, safe

// ❌ AVOID: Manual client management
const client = await pool.connect();
const entity = await repo.findById(id, client);
client.release(); // What if findById throws?
```

---

## Writing Repository Methods

When writing repository methods that accept optional `client`:

```typescript
/**
 * Find entity by ID.
 *
 * @param id - Entity ID
 * @param client - Optional client for use within transactions.
 *                 **WARNING: Caller MUST ensure connection release via try/finally.**
 *                 Prefer using transaction helpers (runInTransaction, runWithLock) instead.
 * @returns Entity or null if not found
 *
 * @example
 * // PREFERRED: Use transaction helpers
 * await runInTransaction(pool, async (client) => {
 *   const entity = await repo.findById(id, client);
 *   await repo.update(entity.id, changes, client);
 * });
 *
 * @example
 * // ACCEPTABLE: Single read without transaction
 * const entity = await repo.findById(id);
 *
 * @example
 * // AVOID: Manual client management (error-prone)
 * const client = await pool.connect();
 * try {
 *   const entity = await repo.findById(id, client);
 * } finally {
 *   client.release(); // Easy to forget in complex error paths
 * }
 */
async findById(id: number, client?: PoolClient): Promise<Entity | null> {
  const queryRunner = client || this.db;
  const result = await queryRunner.query('SELECT * FROM entities WHERE id = $1', [id]);
  return result.rows.length > 0 ? entityFromDatabase(result.rows[0]) : null;
}
```

### JSDoc Template

See `src/shared/jsdoc-templates.ts` for copy-paste templates.

---

## Rare Case: Manual Connection Management

Only for jobs with session-level locks:

```typescript
// ⚠️ MANUAL: Requires explicit try/finally
const client = await pool.connect();
try {
  // Acquire session-level lock
  const lockResult = await client.query('SELECT pg_try_advisory_lock($1)', [lockId]);
  if (!lockResult.rows[0].acquired) {
    return; // Lock not acquired
  }

  try {
    // Do work...
  } finally {
    // Release lock before releasing connection
    await client.query('SELECT pg_advisory_unlock($1)', [lockId]);
  }
} finally {
  // CRITICAL: Always release connection
  client.release();
}
```

---

## Migration Guide

### Identifying Code to Migrate

Search for manual connection management:
```bash
# Find manual pool.connect() calls
grep -r "pool.connect()" --include="*.ts" --exclude-dir=node_modules

# Find repository methods with client? parameter
grep -r "client?: PoolClient" --include="*.ts" --exclude-dir=node_modules
```

### Example Migration

**Before:**
```typescript
async function transferPlayer(fromRosterId: number, toRosterId: number, playerId: number) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM roster_players WHERE roster_id = $1 AND player_id = $2',
      [fromRosterId, playerId]);
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
```

**After:**
```typescript
async function transferPlayer(fromRosterId: number, toRosterId: number, playerId: number) {
  await runWithLocks(pool, [
    { domain: LockDomain.ROSTER, id: Math.min(fromRosterId, toRosterId) },
    { domain: LockDomain.ROSTER, id: Math.max(fromRosterId, toRosterId) },
  ], async (client) => {
    await client.query('DELETE FROM roster_players WHERE roster_id = $1 AND player_id = $2',
      [fromRosterId, playerId]);
    await client.query('INSERT INTO roster_players (roster_id, player_id) VALUES ($1, $2)',
      [toRosterId, playerId]);
    // Connection, transaction, and locks all managed automatically
  });
}
```

---

## Code Review Checklist

When reviewing PRs involving database operations:

- [ ] No manual `pool.connect()` calls without proper try/finally
- [ ] Transaction helpers used for multi-operation sequences
- [ ] `withClient()` used for single read operations
- [ ] Repository methods with `client?` parameter have JSDoc warning
- [ ] No connections held during external API calls
- [ ] No connections held while waiting for user input
- [ ] Locks acquired in consistent domain priority order

---

## Monitoring & Detection

### Production Monitoring

Monitor these metrics:
- `pool.totalCount` - Total connections in pool
- `pool.idleCount` - Available connections
- `pool.waitingCount` - Requests waiting for connection

**Alert if:**
- `waitingCount > 0` for more than 5 seconds
- Connection acquisition time exceeds 1 second
- `idleCount` is consistently 0

### Development Detection (Optional)

Enable connection leak warnings in development:

```typescript
// Add to src/config/database.config.ts
if (process.env.NODE_ENV === 'development') {
  pool.on('connect', (client) => {
    const stack = new Error().stack;
    const timeout = setTimeout(() => {
      logger.warn('Potential connection leak detected', { stack, age: '30s' });
    }, 30000);

    const originalRelease = client.release.bind(client);
    client.release = () => {
      clearTimeout(timeout);
      return originalRelease();
    };
  });
}
```

---

## Key Takeaways

1. **Always use transaction helpers** - Eliminates 99% of connection leak risks
2. **Manual management requires try/finally** - And even then, prefer transaction helpers
3. **Document optional client parameters** - Warn callers about release responsibility
4. **Keep transactions short** - Don't hold connections during I/O or computation
5. **Monitor connection pool** - Alert on waiting requests or slow acquisition

---

## Additional Resources

- **Transaction Patterns**: `.claude/rules/backend/transactions.md`
- **Connection Safety**: `.claude/rules/backend/connection-safety.md`
- **JSDoc Templates**: `src/shared/jsdoc-templates.ts`
- **Transaction Helpers**: `src/shared/transaction-runner.ts`
- **Lock System**: `src/shared/locks.ts`
