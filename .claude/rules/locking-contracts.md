# Locking Contracts

This document defines the locking requirements for write operations across the application.

## Lock Domains

Located in `src/shared/locks.ts`:

| Domain | Offset | Purpose |
|--------|--------|---------|
| LEAGUE | 100,000,000 | League-level configuration changes |
| ROSTER | 200,000,000 | Roster modifications (players, settings) |
| TRADE | 300,000,000 | Trade processing and state changes |
| WAIVER | 400,000,000 | Waiver claim processing |
| AUCTION | 500,000,000 | Auction lot bidding |
| LINEUP | 600,000,000 | Lineup changes |
| DRAFT | 700,000,000 | Draft operations |
| JOB | 900,000,000 | Background job coordination |

## Required Locks by Operation

### Draft Operations

| Operation | Lock Type | Lock ID | Implementation |
|-----------|-----------|---------|----------------|
| Draft pick | DRAFT | draftId | `runInDraftTransaction()` |
| Autopick tick | JOB + DRAFT | 900M+1, draftId | Advisory lock + engine.tick() |
| Draft start | DRAFT | draftId | `DraftStateService.startDraft()` |
| Draft pause/resume | DRAFT | draftId | `DraftStateService` methods |

### Auction Operations

| Operation | Lock Type | Lock ID | Implementation |
|-----------|-----------|---------|----------------|
| Place bid | LOT row lock | N/A | `FOR UPDATE` on lot row + CAS check |
| Lot settlement | JOB | 999999004 | `slow-auction.job.ts` advisory lock |
| Auto-nomination | JOB | 999999005 | `nomination-timeout` advisory lock |

### Trade Operations

| Operation | Lock Type | Lock ID | Implementation |
|-----------|-----------|---------|----------------|
| Propose trade | None | N/A | Immediate insert |
| Accept trade | ROSTER + TRADE | rosterIds, leagueId | Lock both rosters in sorted order, then trade lock |
| Process review-complete | ROSTER + TRADE | rosterIds, leagueId | Same lock pattern as accept trade |
| Cancel trade | TRADE | tradeId | |
| Expire trades | JOB | 900001 | `trade-expiration.job.ts` |

### Waiver Operations

| Operation | Lock Type | Lock ID | Implementation |
|-----------|-----------|---------|----------------|
| Submit claim | None | N/A | Immediate insert |
| Process claims | JOB | 900002 | `waiver-processing.job.ts` |
| Cancel claim | None | N/A | Status update |

### Roster Operations

| Operation | Lock Type | Lock ID | Implementation |
|-----------|-----------|---------|----------------|
| Add player (FA) | LEAGUE | leagueId | `RosterService.addPlayer()` via `runWithLock` |
| Drop player | LEAGUE | leagueId | `RosterService.dropPlayer()` via `runWithLock` |
| Add/drop player (FA) | LEAGUE | leagueId | `RosterService.addDropPlayer()` via `runWithLock` |
| Set lineup | LINEUP | rosterId | `LineupService.setLineup()` |

### Job Coordination

| Job | Lock ID | Purpose |
|-----|---------|---------|
| Stats sync | 999999 (LeaderLock) | Ensure single instance runs |
| Autopick | 900M+1 | Prevent duplicate picks |
| Trade expiration | 900001 | Prevent duplicate processing |
| Waiver processing | 900002 | Prevent duplicate processing |
| Slow auction | 999999004 | Prevent duplicate settlement |
| Nomination timeout | 999999005 | Prevent duplicate nominations |

## Lock Acquisition Order

**CRITICAL:** Always acquire locks in domain priority order to prevent deadlocks:

1. LEAGUE (100M offset)
2. ROSTER (200M)
3. TRADE (300M)
4. WAIVER (400M)
5. AUCTION (500M)
6. LINEUP (600M)
7. DRAFT (700M)
8. JOB (900M)

### Example: Trade Accept

When accepting a trade that involves two rosters:

```typescript
// CORRECT: Acquire locks in ID order within the same domain
const [lowerId, higherId] = [roster1Id, roster2Id].sort((a, b) => a - b);
await lockHelper.withLock(LockDomain.ROSTER, lowerId, async () => {
  await lockHelper.withLock(LockDomain.ROSTER, higherId, async () => {
    // Execute trade
  });
});
```

## Patterns

### Advisory Locks for Jobs

```typescript
const lockResult = await client.query<{ acquired: boolean }>(
  'SELECT pg_try_advisory_lock($1) as acquired',
  [LOCK_ID]
);

if (!lockResult.rows[0].acquired) {
  // Another instance has the lock
  return;
}

try {
  // Do work
} finally {
  await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]);
}
```

### Leader Lock for Stats Sync

```typescript
const leaderLock = container.resolve<LeaderLock>(KEYS.LEADER_LOCK);
const result = await leaderLock.runAsLeader(async () => {
  // Only runs if this instance is the leader
  return await doWork();
});

if (result === null) {
  logger.debug('Not leader, skipping');
}
```

### Row-Level Locks for Auction Bids

```typescript
// Lock the lot row before bidding
const lot = await client.query(
  'SELECT * FROM auction_lots WHERE id = $1 FOR UPDATE',
  [lotId]
);

// CAS check for bid validity
if (lot.current_bid !== expectedCurrentBid) {
  throw new ValidationException('Bid outdated');
}
```

## Transaction Guidelines

1. **Keep transactions short** - Don't hold locks during:
   - External API calls
   - Long computations
   - User input waits

2. **Use runTransaction helpers** - Replace manual `BEGIN/COMMIT/ROLLBACK`:
   ```typescript
   await runTransaction(pool, async (client) => {
     // All operations here are atomic
   });
   ```

3. **Emit events after commit** - Use the DomainEventBus:
   ```typescript
   eventBus.beginTransaction();
   eventBus.publish({ type: 'trade:accepted', ... });
   // After runTransaction completes successfully:
   eventBus.commitTransaction();
   ```
