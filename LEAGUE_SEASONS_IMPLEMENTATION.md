# League Seasons Implementation - Complete Guide

This document provides the complete implementation guide for the league_seasons architecture migration.

## ✅ Completed Components

### Phase 1: Database Migrations (COMPLETED)
- ✅ Migration 079: Created `league_seasons` table
- ✅ Migration 080: Created `keeper_selections` table
- ✅ Migration 081: Added `league_season_id` columns to 17 tables
- ✅ Migration 082: Data migration script with validation
- ✅ Migration 083: NOT NULL constraints and indexes

### Phase 2: Models and Repositories (COMPLETED)
- ✅ `league-season.model.ts` - LeagueSeason model with validation methods
- ✅ `keeper-selection.model.ts` - KeeperSelection model with XOR validation
- ✅ `league-season.repository.ts` - Full CRUD + season management methods
- ✅ `keeper-selection.repository.ts` - Full CRUD + bulk operations

## 🚧 Remaining Implementation Tasks

### Phase 3: Use Cases (HIGH PRIORITY)

#### 1. Rollover to New Season Use Case
**File**: `backend/src/modules/leagues/use-cases/rollover-to-new-season.use-case.ts`

```typescript
import { Pool, PoolClient } from 'pg';
import { runWithLock, LockDomain } from '../../../shared/transaction-runner';
import { LeagueRepository } from '../leagues.repository';
import { LeagueSeasonRepository } from '../league-season.repository';
import { RosterRepository } from '../../rosters/roster.repository';

export interface RolloverParams {
  leagueId: number;
  keeperDeadline?: Date;
}

export class RolloverToNewSeasonUseCase {
  constructor(
    private readonly pool: Pool,
    private readonly leagueRepo: LeagueRepository,
    private readonly leagueSeasonRepo: LeagueSeasonRepository,
    private readonly rosterRepo: RosterRepository
  ) {}

  async execute(params: RolloverParams): Promise<{ newSeason: LeagueSeason }> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      // Use LEAGUE lock domain (100M offset)
      await runWithLock(client, LockDomain.LEAGUE, params.leagueId, async () => {

        // 1. Validate league mode (dynasty/keeper/devy only)
        const league = await this.leagueRepo.findById(params.leagueId, client);
        if (!league) {
          throw new Error('League not found');
        }
        if (league.mode === 'redraft') {
          throw new Error('Redraft leagues should use reset, not rollover');
        }

        // 2. Get current active season
        const currentSeason = await this.leagueSeasonRepo.findActiveByLeague(params.leagueId, client);
        if (!currentSeason) {
          throw new Error('No active season found to rollover from');
        }

        // 3. Verify current season is in completable state
        if (currentSeason.status !== 'playoffs' && currentSeason.status !== 'in_season') {
          throw new Error(`Cannot rollover from status: ${currentSeason.status}`);
        }

        // 4. Mark previous season as completed
        await this.leagueSeasonRepo.markCompleted(currentSeason.id, client);

        // 5. Create new season
        const newSeasonYear = currentSeason.season + 1;
        const keeperDeadline = params.keeperDeadline || new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);

        const newSeason = await this.leagueSeasonRepo.create({
          leagueId: params.leagueId,
          season: newSeasonYear,
          status: 'pre_draft',
          seasonStatus: 'pre_season',
          currentWeek: 1,
          seasonSettings: {
            keeper_deadline: keeperDeadline.toISOString(),
            max_keepers: league.leagueSettings?.maxKeepers || 3
          }
        }, client);

        // 6. Copy rosters to new season (preserve ownership, reset players)
        await this.copyRostersToNewSeason(client, currentSeason.id, newSeason.id);

        // 7. Initialize waiver priorities (copy from previous season)
        await this.initializeWaiverPriorities(client, newSeason.id, currentSeason.id);

        // 8. Initialize FAAB budgets (reset to default)
        await this.initializeFAABBudgets(client, newSeason.id, league);

        return { newSeason };
      });

      await client.query('COMMIT');

      // Return result from lock callback
      // Note: Need to fetch outside transaction since lock callback doesn't return value
      const newSeason = await this.leagueSeasonRepo.findByLeagueAndSeason(
        params.leagueId,
        (await this.leagueSeasonRepo.getLatestSeasonNumber(params.leagueId))!
      );

      return { newSeason: newSeason! };

    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async copyRostersToNewSeason(
    client: PoolClient,
    oldSeasonId: number,
    newSeasonId: number
  ): Promise<void> {
    // Copy rosters with same user_id and roster_id, but empty players
    await client.query(
      `INSERT INTO rosters (league_season_id, user_id, roster_id, settings, starters, bench)
       SELECT $1, user_id, roster_id, settings, '[]'::jsonb, '[]'::jsonb
       FROM rosters
       WHERE league_season_id = $2`,
      [newSeasonId, oldSeasonId]
    );
  }

  private async initializeWaiverPriorities(
    client: PoolClient,
    newSeasonId: number,
    oldSeasonId: number
  ): Promise<void> {
    const newSeason = await client.query(
      'SELECT season FROM league_seasons WHERE id = $1',
      [newSeasonId]
    );
    const seasonYear = newSeason.rows[0].season;

    // Copy waiver priorities from end of previous season
    await client.query(
      `INSERT INTO waiver_priority (league_season_id, roster_id, season, priority)
       SELECT $1, r_new.id, $2, wp.priority
       FROM waiver_priority wp
       JOIN rosters r_old ON wp.roster_id = r_old.id
       JOIN rosters r_new ON r_new.league_season_id = $1 AND r_new.roster_id = r_old.roster_id
       WHERE wp.league_season_id = $3
       ORDER BY wp.priority`,
      [newSeasonId, seasonYear, oldSeasonId]
    );
  }

  private async initializeFAABBudgets(
    client: PoolClient,
    newSeasonId: number,
    league: League
  ): Promise<void> {
    const seasonYear = (await client.query(
      'SELECT season FROM league_seasons WHERE id = $1',
      [newSeasonId]
    )).rows[0].season;

    const initialBudget = league.leagueSettings?.faabBudget || 100;

    await client.query(
      `INSERT INTO faab_budgets (league_season_id, roster_id, season, initial_budget, remaining_budget)
       SELECT $1, id, $2, $3, $3
       FROM rosters
       WHERE league_season_id = $1`,
      [newSeasonId, seasonYear, initialBudget]
    );
  }
}
```

#### 2. Submit Keeper Selection Use Case
**File**: `backend/src/modules/leagues/use-cases/submit-keeper-selection.use-case.ts`

```typescript
import { Pool, PoolClient } from 'pg';
import { LeagueSeasonRepository } from '../league-season.repository';
import { KeeperSelectionRepository, CreateKeeperSelectionParams } from '../keeper-selection.repository';
import { LeagueRepository } from '../leagues.repository';

export interface SubmitKeepersParams {
  leagueSeasonId: number;
  rosterId: number;
  selections: Array<{
    playerId?: number;
    draftPickAssetId?: number;
    keeperRoundCost?: number;
  }>;
}

export class SubmitKeeperSelectionUseCase {
  constructor(
    private readonly pool: Pool,
    private readonly leagueSeasonRepo: LeagueSeasonRepository,
    private readonly keeperRepo: KeeperSelectionRepository,
    private readonly leagueRepo: LeagueRepository
  ) {}

  async execute(params: SubmitKeepersParams): Promise<void> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      // 1. Get season and validate keeper deadline
      const season = await this.leagueSeasonRepo.findById(params.leagueSeasonId, client);
      if (!season) {
        throw new Error('League season not found');
      }

      if (season.isKeeperDeadlinePassed()) {
        throw new Error('Keeper deadline has passed');
      }

      // 2. Get league and validate keeper count
      const league = await this.leagueRepo.findById(season.leagueId, client);
      if (!league) {
        throw new Error('League not found');
      }

      const maxKeepers = season.getMaxKeepers();
      if (params.selections.length > maxKeepers) {
        throw new Error(`Cannot keep more than ${maxKeepers} players`);
      }

      // 3. Delete existing keeper selections for this roster
      await this.keeperRepo.deleteByRoster(params.rosterId, params.leagueSeasonId, client);

      // 4. Insert new keeper selections
      const createParams: CreateKeeperSelectionParams[] = params.selections.map(sel => ({
        leagueSeasonId: params.leagueSeasonId,
        rosterId: params.rosterId,
        playerId: sel.playerId,
        draftPickAssetId: sel.draftPickAssetId,
        keeperRoundCost: sel.keeperRoundCost
      }));

      if (createParams.length > 0) {
        await this.keeperRepo.bulkCreate(createParams, client);
      }

      await client.query('COMMIT');

    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
```

#### 3. Apply Keepers to Rosters Use Case
**File**: `backend/src/modules/leagues/use-cases/apply-keepers-to-rosters.use-case.ts`

```typescript
import { Pool, PoolClient } from 'pg';
import { KeeperSelectionRepository } from '../keeper-selection.repository';

export class ApplyKeepersToRostersUseCase {
  constructor(
    private readonly pool: Pool,
    private readonly keeperRepo: KeeperSelectionRepository
  ) {}

  async execute(leagueSeasonId: number): Promise<void> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      // Get all keeper selections for this season
      const keepers = await this.keeperRepo.findByLeagueSeason(leagueSeasonId, client);

      // Add kept players to roster_players table
      for (const keeper of keepers) {
        if (keeper.isPlayer()) {
          // Check if player already exists in roster_players
          const existing = await client.query(
            'SELECT 1 FROM roster_players WHERE roster_id = $1 AND player_id = $2',
            [keeper.rosterId, keeper.playerId]
          );

          if (existing.rows.length === 0) {
            await client.query(
              `INSERT INTO roster_players (roster_id, player_id, acquired_via)
               VALUES ($1, $2, 'keeper')`,
              [keeper.rosterId, keeper.playerId]
            );
          }
        }
        // Pick assets don't need to be applied - they're already owned
      }

      await client.query('COMMIT');

    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
```

### Phase 4: Repository Updates (MEDIUM PRIORITY)

All repositories that query seasonal data need to be updated. The pattern is:

**BEFORE:**
```typescript
WHERE league_id = $1
```

**AFTER:**
```typescript
WHERE league_season_id = $1
```

**Critical repositories to update:**
1. `backend/src/modules/rosters/roster.repository.ts`
2. `backend/src/modules/drafts/drafts.repository.ts`
3. `backend/src/modules/matchups/matchups.repository.ts`
4. `backend/src/modules/trades/trades.repository.ts`
5. `backend/src/modules/waivers/waivers.repository.ts`
6. `backend/src/modules/playoffs/playoff.repository.ts`

**Pattern for backwards compatibility:**
```typescript
// Add new method for league_season_id
async findByLeagueSeasonId(leagueSeasonId: number): Promise<T[]> {
  return this.pool.query('SELECT * FROM table WHERE league_season_id = $1', [leagueSeasonId]);
}

// Update old method to resolve active season
async findByLeagueId(leagueId: number): Promise<T[]> {
  const activeSeason = await this.leagueSeasonRepo.findActiveByLeague(leagueId);
  if (!activeSeason) throw new Error('No active season');
  return this.findByLeagueSeasonId(activeSeason.id);
}
```

### Phase 5: API Endpoints (MEDIUM PRIORITY)

#### New Season Management Endpoints
Add to `backend/src/modules/leagues/leagues.routes.ts`:

```typescript
// Season management
router.get('/leagues/:leagueId/seasons', authenticateToken, getLeagueSeasons);
router.get('/leagues/:leagueId/seasons/:seasonId', authenticateToken, getLeagueSeason);
router.post('/leagues/:leagueId/seasons/rollover', authenticateToken, rolloverToNewSeason);

// Keeper management
router.get('/leagues/:leagueId/seasons/:seasonId/keepers', authenticateToken, getKeeperSelections);
router.post('/leagues/:leagueId/seasons/:seasonId/keepers', authenticateToken, submitKeeperSelections);
router.get('/leagues/:leagueId/seasons/:seasonId/keepers/:rosterId', authenticateToken, getRosterKeepers);
```

#### Backwards Compatibility Middleware
```typescript
// Middleware to resolve leagueId → active leagueSeasonId
async function resolveActiveSeason(req, res, next) {
  const leagueId = parseInt(req.params.leagueId);
  const activeSeason = await leagueSeasonRepo.findActiveByLeague(leagueId);
  if (!activeSeason) {
    return res.status(404).json({ error: 'No active season found' });
  }
  req.activeSeasonId = activeSeason.id;
  next();
}

// Apply to existing endpoints
router.get('/leagues/:leagueId/rosters', authenticateToken, resolveActiveSeason, getRosters);
router.get('/leagues/:leagueId/drafts', authenticateToken, resolveActiveSeason, getDrafts);
// etc...
```

### Phase 6: Migration Execution Plan

**CRITICAL: Follow this order**

1. **Backup database**
   ```bash
   pg_dump -h localhost -U postgres hyp...
(truncated at 15000 characters due to length limits)
