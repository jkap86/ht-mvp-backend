# Idempotency Strategy

This document describes the idempotency implementation for HypeTrainFF MVP to ensure safe retries of API operations.

## Overview

The application uses a **hybrid idempotency approach** with two complementary systems:

1. **Per-Feature Operations Tables** - For complex, stateful operations
2. **Per-Entity Idempotency Columns** - For simple insert operations

This strategy provides:
- Safe retries for all mutation endpoints
- Prevention of duplicate operations
- Cached responses for deterministic replay
- Efficient cleanup and TTL management

---

## Per-Feature Operations Tables

Use operation tables for complex, multi-step operations that need to cache full response data.

### Tables

| Table | Purpose | Operations | TTL |
|-------|---------|-----------|-----|
| `league_operations` | League lifecycle | create, join, reset, season-controls | 24h |
| `draft_operations` | Draft state changes | start, randomize, confirm, pause, resume, undo | 24h |
| `playoff_operations` | Playoff management | generate, advance | 24h |

### Schema Pattern

```sql
CREATE TABLE league_operations (
  id SERIAL PRIMARY KEY,
  idempotency_key TEXT NOT NULL,
  league_id INTEGER,  -- Nullable for create (league doesn't exist yet)
  user_id UUID NOT NULL,
  operation_type TEXT NOT NULL,  -- e.g., 'create', 'join', 'reset'
  response_data JSONB NOT NULL,  -- Cached response to return on retry
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '24 hours'),

  UNIQUE (idempotency_key, user_id, operation_type)
);
```

### Implementation Pattern

```typescript
// 1. Check for existing operation
if (idempotencyKey) {
  const existing = await operationsRepo.findByKey(
    entityId, userId, idempotencyKey, client
  );
  if (existing) return existing.response_data; // Replay cached response
}

// 2. Execute operation inside transaction + lock
await runWithLock(db, LockDomain.LEAGUE, leagueId, async (client) => {
  // Perform operation...
  const result = await performOperation(client);

  // 3. Store operation for future retries
  if (idempotencyKey) {
    await operationsRepo.create(
      entityId, userId, operationType, idempotencyKey, result, client
    );
  }

  return result;
});
```

### Cleanup

Operations expire after 24 hours and are cleaned up by the idempotency cleanup job:
- Job runs every 1 hour
- Deletes rows where `expires_at < NOW()`

---

## Per-Entity Idempotency Columns

Use entity columns for simple insert operations where the entity itself represents the idempotency boundary.

### Tables

| Table | Column | Purpose |
|-------|--------|---------|
| `draft_picks` | `idempotency_key` | Prevent duplicate picks on retry |
| `waiver_claims` | `idempotency_key` | Prevent duplicate claims |
| `trades` | `idempotency_key` | Prevent duplicate trade proposals |

### Schema Pattern

```sql
ALTER TABLE draft_picks
  ADD COLUMN idempotency_key TEXT;

-- Partial unique index (only for non-null keys)
CREATE UNIQUE INDEX idx_draft_picks_idempotency
  ON draft_picks (draft_id, roster_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
```

### Implementation Pattern

```typescript
// 1. Check for existing entity with same key
if (idempotencyKey) {
  const existing = await repo.findByIdempotencyKey(
    draftId, rosterId, idempotencyKey, client
  );
  if (existing) return existing; // Return existing entity
}

// 2. Create entity with idempotency key
await runWithLock(db, LockDomain.DRAFT, draftId, async (client) => {
  const pick = await repo.create({
    draftId,
    rosterId,
    playerId,
    idempotencyKey,  // Store key with entity
  }, client);

  return pick;
});
```

### Cleanup

Entity idempotency keys are permanent (no TTL). They serve as:
- Primary deduplication mechanism
- Audit trail for when operations occurred

---

## Special Cases

### Auction Bids

Auction bids use a combination approach:
- `auction_nominations` table with `idempotency_key` column
- `auction_bid_history` for bid tracking (inherent idempotency via timestamp)

### Waiver Processing

Waiver processing uses `waiver_processing_runs` with:
- Unique constraint on `(league_id, season, week, window_start_at)`
- Status tracking ('processing', 'completed', 'failed')
- Prevents duplicate processing windows

---

## Client Implementation

### Generating Keys

Frontend generates UUID v4 keys:

```dart
final idempotencyKey = const Uuid().v4();

await _apiClient.post(
  '/leagues/$leagueId/join',
  idempotencyKey: idempotencyKey,
);
```

### Retry Strategy

- Generate key **once** before first attempt
- **Reuse same key** on retry
- Clear key only after successful response

### Header

All mutation endpoints accept the `x-idempotency-key` header:

```http
POST /api/leagues/123/join
x-idempotency-key: 550e8400-e29b-41d4-a716-446655440000
```

---

## Endpoint Coverage

### ✓ Fully Idempotent

| Endpoint | Method | Table/Column |
|----------|--------|--------------|
| Create league | POST | league_operations |
| Join public league | POST | league_operations |
| Reset league | POST | league_operations |
| Season controls | POST | league_operations |
| Start draft | POST | draft_operations |
| Randomize order | POST | draft_operations |
| Confirm order | POST | draft_operations |
| Make pick | POST | draft_picks.idempotency_key |
| Undo pick | POST | draft_operations |
| Nominate (auction) | POST | auction_nominations.idempotency_key |
| Place bid | POST | auction_bid_history |
| Submit waiver claim | POST | waiver_claims.idempotency_key |
| Cancel claim | POST | Soft idempotent (status check) |
| Propose trade | POST | trades.idempotency_key |
| Accept trade | POST | Soft idempotent (status check) |

### Soft Idempotent

Some operations are "soft idempotent" - retrying returns current state without error:

```typescript
// Example: acceptTrade
if (trade.status === 'accepted') {
  return getTradeDetails(); // Already accepted, return current state
}
```

---

## Lock Coordination

Idempotency checks must occur **inside locks** to prevent race conditions:

```typescript
// WRONG - Race condition possible
if (await findExisting(key)) return existing;
await lock();
await create();

// RIGHT - Check inside lock
await lock();
if (await findExisting(key)) return existing;
await create();
```

Always use transaction helpers that acquire locks:
- `runWithLock(db, domain, id, fn)`
- `runInDraftTransaction(pool, draftId, fn)`
- `runInTransaction(pool, fn)`

---

## Testing Idempotency

### Manual Test

```bash
# Generate a key
KEY="550e8400-e29b-41d4-a716-446655440000"

# First request
curl -X POST http://localhost:3000/api/leagues/123/join \
  -H "x-idempotency-key: $KEY" \
  -H "Authorization: Bearer $TOKEN"

# Retry with same key (should return same result, no duplicate)
curl -X POST http://localhost:3000/api/leagues/123/join \
  -H "x-idempotency-key: $KEY" \
  -H "Authorization: Bearer $TOKEN"
```

### Unit Test Pattern

```typescript
it('should be idempotent with same key', async () => {
  const key = 'test-key-123';

  // First call
  const result1 = await service.createLeague(input, userId, key);

  // Second call with same key
  const result2 = await service.createLeague(input, userId, key);

  // Should return cached response
  expect(result1.id).toBe(result2.id);

  // Should not create duplicate
  const count = await repo.count();
  expect(count).toBe(1);
});
```

---

## Migration from HTTP Middleware

**Previous Approach:**

The application previously used HTTP-level idempotency middleware that:
- Intercepted all POST/PUT/PATCH/DELETE requests
- Stored responses in `idempotency_keys` table
- Had issues: ran before auth, didn't scope by method, used `originalUrl`

**Why We Changed:**

1. **Auth timing** - Middleware ran before user was authenticated
2. **Limited context** - Couldn't distinguish operation types
3. **Generic responses** - 24h TTL didn't fit all use cases
4. **Over-engineering** - Feature tables provide better control

**Migration Path:**

- HTTP middleware removed (no longer registered in server.ts)
- `idempotency_keys` table can be dropped after confirming no active usage
- All mutation endpoints now use per-feature or per-entity approach

---

## Best Practices

### DO

✅ Generate idempotency keys on the client
✅ Check for existing operations **inside locks**
✅ Store keys with entities for permanent audit trail
✅ Use operation tables for complex, multi-step operations
✅ Return cached responses on duplicate keys
✅ Set appropriate TTLs for operation tables

### DON'T

❌ Generate keys on the server (client controls retry)
❌ Check idempotency outside locks (race conditions)
❌ Use HTTP middleware for idempotency (removed)
❌ Ignore idempotency keys (always accept and honor)
❌ Return errors on duplicate keys (return success + cached response)

---

## Future Improvements

1. **Event Sourcing** - Store all operations as immutable events
2. **Distributed Locks** - Use Redis for cross-instance coordination
3. **Replay API** - Admin endpoint to replay operations from idempotency log
4. **Monitoring** - Track idempotency hit rate and duplicate request frequency
