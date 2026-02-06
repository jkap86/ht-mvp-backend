# System Message Guidelines

## Transaction Safety

**Rule:** Never broadcast system messages inside a database transaction.

### Why?

Broadcasting inside a transaction can emit messages for operations that later roll back, causing inconsistent state between what users see and what's in the database.

### Safe Patterns

1. **Outside transaction:** Use `createAndBroadcast()`

   ```typescript
   // After transaction commits (or no transaction needed)
   await systemMessageService.createAndBroadcast(leagueId, 'trade_completed', { ... });
   ```

2. **Inside transaction:** Use `create(..., client)` then call `broadcast()` after commit

   ```typescript
   const client = await db.connect();
   try {
     await client.query('BEGIN');

     // ... do work ...

     // Create message record inside transaction (no broadcast)
     const message = await systemMessageService.create(leagueId, 'trade_completed', data, client);

     await client.query('COMMIT');

     // Broadcast AFTER commit succeeds
     await systemMessageService.broadcast(message);
   } catch (error) {
     await client.query('ROLLBACK');
     throw error;
   } finally {
     client.release();
   }
   ```

### Error Handling

System message failures should not break the main operation. Use fire-and-forget with logging:

```typescript
systemMessageService
  .createAndBroadcast(leagueId, 'event_type', data)
  .catch((err) => logger.warn('Failed to emit system message', {
    type: 'event_type',
    leagueId,
    error: err.message
  }));
```

### Current Implementation

Most system messages in the codebase are emitted **after** transactions commit using the fire-and-forget pattern above. The `EventListenerService` methods handle trade/waiver events and are called post-commit.
