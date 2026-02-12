import { Pool, PoolClient } from 'pg';
import { Player, playerFromDatabase } from './players.model';
import { SleeperPlayer } from '../../integrations/sleeper/sleeper-api-client';
import { CFBDPlayer } from './cfbd.client';
import { PlayerMasterData } from '../../integrations/shared/stats-provider.types';
import { ExternalIdRepository } from './external-ids.repository';

export class PlayerRepository {
  constructor(private readonly db: Pool) {}

  /**
   * Find a player by ID using an existing transaction client.
   * Use this inside transactions to avoid connection churn.
   */
  async findByIdWithClient(client: PoolClient, id: number): Promise<Player | null> {
    const result = await client.query('SELECT * FROM players WHERE id = $1', [id]);
    return result.rows.length > 0 ? playerFromDatabase(result.rows[0]) : null;
  }

  /**
   * Find a random eligible player for auction auto-nomination.
   * Uses SQL-level filtering to avoid loading all players into memory.
   * Excludes players that are already drafted or already nominated in this draft.
   * @param client - Transaction client for consistency
   * @param draftId - Draft to check eligibility for
   * @returns A random available player, or null if none available
   */
  async findRandomEligiblePlayerForAuction(
    client: PoolClient,
    draftId: number
  ): Promise<Player | null> {
    // Use OFFSET-based random selection instead of ORDER BY RANDOM()
    // to avoid a full-table scan + sort. First get the count of eligible
    // players, then pick one at a random offset.
    const countResult = await client.query(
      `SELECT COUNT(*) AS cnt
       FROM players p
       WHERE p.active = true
         AND NOT EXISTS (
           SELECT 1 FROM draft_picks dp
           WHERE dp.draft_id = $1 AND dp.player_id = p.id
         )
         AND NOT EXISTS (
           SELECT 1 FROM auction_lots al
           WHERE al.draft_id = $1 AND al.player_id = p.id
         )`,
      [draftId]
    );

    const totalEligible = parseInt(countResult.rows[0].cnt, 10);
    if (totalEligible === 0) {
      return null;
    }

    const randomOffset = Math.floor(Math.random() * totalEligible);

    const result = await client.query(
      `SELECT p.*
       FROM players p
       WHERE p.active = true
         AND NOT EXISTS (
           SELECT 1 FROM draft_picks dp
           WHERE dp.draft_id = $1 AND dp.player_id = p.id
         )
         AND NOT EXISTS (
           SELECT 1 FROM auction_lots al
           WHERE al.draft_id = $1 AND al.player_id = p.id
         )
       OFFSET $2
       LIMIT 1`,
      [draftId, randomOffset]
    );
    return result.rows.length > 0 ? playerFromDatabase(result.rows[0]) : null;
  }

  async findAll(limit = 100, offset = 0): Promise<Player[]> {
    const result = await this.db.query(
      `SELECT * FROM players WHERE active = true ORDER BY full_name LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    return result.rows.map(playerFromDatabase);
  }

  async findById(id: number): Promise<Player | null> {
    const result = await this.db.query('SELECT * FROM players WHERE id = $1', [id]);
    return result.rows.length > 0 ? playerFromDatabase(result.rows[0]) : null;
  }

  async findByIds(ids: number[]): Promise<Player[]> {
    if (ids.length === 0) return [];
    const result = await this.db.query('SELECT * FROM players WHERE id = ANY($1)', [ids]);
    return result.rows.map(playerFromDatabase);
  }

  /**
   * Find multiple players by IDs with details needed for trade items.
   * Returns a map of player ID to player details for efficient lookup.
   * Uses batch query to avoid N+1 problem.
   */
  async findByIdsWithDetails(
    ids: number[],
    client?: PoolClient
  ): Promise<Map<number, { fullName: string; position: string | null; team: string | null }>> {
    if (ids.length === 0) return new Map();
    const db = client || this.db;
    const result = await db.query(
      'SELECT id, full_name, position, team FROM players WHERE id = ANY($1)',
      [ids]
    );
    const map = new Map<number, { fullName: string; position: string | null; team: string | null }>();
    for (const row of result.rows) {
      map.set(row.id, {
        fullName: row.full_name,
        position: row.position,
        team: row.team,
      });
    }
    return map;
  }

  async findBySleeperId(sleeperId: string): Promise<Player | null> {
    const result = await this.db.query('SELECT * FROM players WHERE sleeper_id = $1', [sleeperId]);
    return result.rows.length > 0 ? playerFromDatabase(result.rows[0]) : null;
  }

  async search(
    query: string,
    position?: string,
    team?: string,
    playerType?: 'nfl' | 'college',
    playerPool?: ('veteran' | 'rookie' | 'college')[],
    limit = 200
  ): Promise<Player[]> {
    let sql = `SELECT * FROM players WHERE active = true`;
    const params: any[] = [];
    let paramIndex = 1;

    // Only add name filter if query is provided
    if (query && query.trim().length > 0) {
      // Escape LIKE wildcards to prevent enumeration via % or _
      const escapedQuery = query.replace(/[%_\\]/g, '\\$&');
      sql += ` AND LOWER(full_name) LIKE LOWER($${paramIndex++}) ESCAPE '\\'`;
      params.push(`%${escapedQuery}%`);
    }

    if (position) {
      sql += ` AND position = $${paramIndex++}`;
      params.push(position);
    }

    if (team) {
      sql += ` AND team = $${paramIndex++}`;
      params.push(team);
    }

    // New playerPool filtering takes precedence over legacy playerType
    if (playerPool && playerPool.length > 0) {
      const conditions: string[] = [];
      if (playerPool.includes('veteran')) {
        conditions.push("(player_type = 'nfl' AND (years_exp > 0 OR years_exp IS NULL))");
      }
      if (playerPool.includes('rookie')) {
        conditions.push("(player_type = 'nfl' AND years_exp = 0)");
      }
      if (playerPool.includes('college')) {
        conditions.push("(player_type = 'college')");
      }
      if (conditions.length > 0) {
        sql += ` AND (${conditions.join(' OR ')})`;
      }
    } else if (playerType) {
      // Legacy playerType filter
      sql += ` AND player_type = $${paramIndex++}`;
      params.push(playerType);
    }

    sql += ` ORDER BY full_name LIMIT $${paramIndex}`;
    params.push(limit);

    const result = await this.db.query(sql, params);
    return result.rows.map(playerFromDatabase);
  }

  async upsertFromSleeper(sleeperPlayer: SleeperPlayer): Promise<void> {
    await this.db.query(
      `INSERT INTO players (
        sleeper_id, first_name, last_name, full_name, fantasy_positions,
        position, team, years_exp, age, active, status, injury_status, jersey_number
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      ON CONFLICT (sleeper_id) DO UPDATE SET
        first_name = EXCLUDED.first_name,
        last_name = EXCLUDED.last_name,
        full_name = EXCLUDED.full_name,
        fantasy_positions = EXCLUDED.fantasy_positions,
        position = EXCLUDED.position,
        team = EXCLUDED.team,
        years_exp = EXCLUDED.years_exp,
        age = EXCLUDED.age,
        active = EXCLUDED.active,
        status = EXCLUDED.status,
        injury_status = EXCLUDED.injury_status,
        jersey_number = EXCLUDED.jersey_number,
        updated_at = CURRENT_TIMESTAMP`,
      [
        sleeperPlayer.player_id,
        sleeperPlayer.first_name || null,
        sleeperPlayer.last_name || null,
        sleeperPlayer.full_name || `${sleeperPlayer.first_name} ${sleeperPlayer.last_name}`,
        sleeperPlayer.fantasy_positions || [],
        sleeperPlayer.position || null,
        sleeperPlayer.team || null,
        sleeperPlayer.years_exp || null,
        sleeperPlayer.age || null,
        sleeperPlayer.active ?? true,
        sleeperPlayer.status || null,
        sleeperPlayer.injury_status || null,
        sleeperPlayer.number || null,
      ]
    );
  }

  async getPlayerCount(): Promise<number> {
    const result = await this.db.query('SELECT COUNT(*) as count FROM players WHERE active = true');
    return Number(result.rows[0].count) || 0;
  }

  /**
   * Get mapping of external_id to internal player_id for a specific provider
   * This is the provider-agnostic version that queries the external_ids table
   * @param provider - Provider identifier (e.g., 'sleeper', 'fantasypros')
   * @returns Map of external_id -> player_id
   */
  async getExternalIdMapForProvider(provider: string): Promise<Map<string, number>> {
    const result = await this.db.query(
      'SELECT external_id, player_id FROM player_external_ids WHERE provider = $1',
      [provider]
    );
    const map = new Map<string, number>();
    for (const row of result.rows) {
      map.set(row.external_id, row.player_id);
    }
    return map;
  }

  /**
   * Get mapping of sleeper_id to internal player_id for all players
   * @deprecated Use getExternalIdMapForProvider('sleeper') instead
   * Kept for backward compatibility during migration
   * Uses fallback logic: tries external_ids table first, falls back to legacy column
   */
  async getSleeperIdMap(): Promise<Map<string, number>> {
    // Check if external_ids table has data for sleeper provider
    const externalIdsExist = await this.db.query(
      "SELECT EXISTS(SELECT 1 FROM player_external_ids WHERE provider = 'sleeper' LIMIT 1)"
    );

    if (externalIdsExist.rows[0].exists) {
      // Use new external_ids table
      return this.getExternalIdMapForProvider('sleeper');
    }

    // Fall back to legacy sleeper_id column during migration
    const result = await this.db.query(
      'SELECT sleeper_id, id FROM players WHERE sleeper_id IS NOT NULL'
    );
    const map = new Map<string, number>();
    for (const row of result.rows) {
      map.set(row.sleeper_id, row.id);
    }
    return map;
  }

  /**
   * Batch upsert players from Sleeper API for better performance.
   * Processes players in batches to avoid memory issues and improve throughput.
   */
  async batchUpsertFromSleeper(sleeperPlayers: SleeperPlayer[], batchSize = 100): Promise<number> {
    if (sleeperPlayers.length === 0) {
      return 0;
    }

    let totalUpserted = 0;

    // Process in batches
    for (let i = 0; i < sleeperPlayers.length; i += batchSize) {
      const batch = sleeperPlayers.slice(i, i + batchSize);

      // Build parameterized batch insert
      const values: any[] = [];
      const placeholders = batch
        .map((player, idx) => {
          const baseIdx = idx * 13;
          values.push(
            player.player_id,
            player.first_name || null,
            player.last_name || null,
            player.full_name || `${player.first_name} ${player.last_name}`,
            player.fantasy_positions || [],
            player.position || null,
            player.team || null,
            player.years_exp || null,
            player.age || null,
            player.active ?? true,
            player.status || null,
            player.injury_status || null,
            player.number || null
          );
          return `($${baseIdx + 1}, $${baseIdx + 2}, $${baseIdx + 3}, $${baseIdx + 4}, $${baseIdx + 5}, $${baseIdx + 6}, $${baseIdx + 7}, $${baseIdx + 8}, $${baseIdx + 9}, $${baseIdx + 10}, $${baseIdx + 11}, $${baseIdx + 12}, $${baseIdx + 13})`;
        })
        .join(', ');

      await this.db.query(
        `INSERT INTO players (
          sleeper_id, first_name, last_name, full_name, fantasy_positions,
          position, team, years_exp, age, active, status, injury_status, jersey_number
        ) VALUES ${placeholders}
        ON CONFLICT (sleeper_id) DO UPDATE SET
          first_name = EXCLUDED.first_name,
          last_name = EXCLUDED.last_name,
          full_name = EXCLUDED.full_name,
          fantasy_positions = EXCLUDED.fantasy_positions,
          position = EXCLUDED.position,
          team = EXCLUDED.team,
          years_exp = EXCLUDED.years_exp,
          age = EXCLUDED.age,
          active = EXCLUDED.active,
          status = EXCLUDED.status,
          injury_status = EXCLUDED.injury_status,
          jersey_number = EXCLUDED.jersey_number,
          updated_at = CURRENT_TIMESTAMP`,
        values
      );

      totalUpserted += batch.length;
    }

    return totalUpserted;
  }

  /**
   * Batch upsert college players from CFBD API.
   * Processes players in batches to avoid memory issues and improve throughput.
   */
  async batchUpsertFromCFBD(cfbdPlayers: CFBDPlayer[], batchSize = 100): Promise<number> {
    if (cfbdPlayers.length === 0) {
      return 0;
    }

    let totalUpserted = 0;

    // Process in batches
    for (let i = 0; i < cfbdPlayers.length; i += batchSize) {
      const batch = cfbdPlayers.slice(i, i + batchSize);

      // Build parameterized batch insert
      const values: any[] = [];
      const placeholders = batch
        .map((player, idx) => {
          const baseIdx = idx * 14;
          const fullName = `${player.firstName || ''} ${player.lastName || ''}`.trim() || 'Unknown';
          // Convert height from inches to display format (e.g., "6-2")
          const heightDisplay = player.height
            ? `${Math.floor(player.height / 12)}-${player.height % 12}`
            : null;

          values.push(
            player.id, // cfbd_id
            player.firstName || null,
            player.lastName || null,
            fullName,
            player.position || null,
            player.team || null, // team name as stored in CFBD
            player.jersey || null,
            player.team || null, // college (same as team for college players)
            heightDisplay,
            player.weight || null,
            player.homeCity || null,
            player.homeState || null,
            'college', // player_type
            true // active
          );
          return `($${baseIdx + 1}, $${baseIdx + 2}, $${baseIdx + 3}, $${baseIdx + 4}, $${baseIdx + 5}, $${baseIdx + 6}, $${baseIdx + 7}, $${baseIdx + 8}, $${baseIdx + 9}, $${baseIdx + 10}, $${baseIdx + 11}, $${baseIdx + 12}, $${baseIdx + 13}, $${baseIdx + 14})`;
        })
        .join(', ');

      await this.db.query(
        `INSERT INTO players (
          cfbd_id, first_name, last_name, full_name, position, team,
          jersey_number, college, height, weight, home_city, home_state,
          player_type, active
        ) VALUES ${placeholders}
        ON CONFLICT (cfbd_id) DO UPDATE SET
          first_name = EXCLUDED.first_name,
          last_name = EXCLUDED.last_name,
          full_name = EXCLUDED.full_name,
          position = EXCLUDED.position,
          team = EXCLUDED.team,
          jersey_number = EXCLUDED.jersey_number,
          college = EXCLUDED.college,
          height = EXCLUDED.height,
          weight = EXCLUDED.weight,
          home_city = EXCLUDED.home_city,
          home_state = EXCLUDED.home_state,
          player_type = 'college',
          active = true,
          updated_at = CURRENT_TIMESTAMP`,
        values
      );

      totalUpserted += batch.length;
    }

    return totalUpserted;
  }

  /**
   * Get count of college players
   */
  async getCollegePlayerCount(): Promise<number> {
    const result = await this.db.query(
      "SELECT COUNT(*) as count FROM players WHERE active = true AND player_type = 'college'"
    );
    return Number(result.rows[0].count) || 0;
  }

  /**
   * Get list of college teams that have already been synced
   */
  async getSyncedCollegeTeams(): Promise<string[]> {
    const result = await this.db.query(
      "SELECT DISTINCT team FROM players WHERE player_type = 'college' AND team IS NOT NULL"
    );
    return result.rows.map((row) => row.team);
  }

  /**
   * Batch upsert players from provider master data (provider-agnostic version)
   * This method works with any stats provider using the domain DTOs
   * @param playerData - Array of player master data from provider
   * @param provider - Provider identifier (e.g., 'sleeper', 'fantasypros')
   * @param externalIdRepo - Repository for managing external ID mappings
   * @param batchSize - Number of players to process per batch
   * @returns Number of players upserted
   */
  async batchUpsertFromProvider(
    playerData: PlayerMasterData[],
    provider: string,
    externalIdRepo: ExternalIdRepository,
    batchSize = 100
  ): Promise<number> {
    if (playerData.length === 0) {
      return 0;
    }

    let totalUpserted = 0;

    // Process in batches
    for (let i = 0; i < playerData.length; i += batchSize) {
      const batch = playerData.slice(i, i + batchSize);

      // Build parameterized batch insert (without sleeper_id - that goes in external_ids table)
      const values: any[] = [];
      const placeholders = batch
        .map((player, idx) => {
          const baseIdx = idx * 11;
          values.push(
            player.firstName || null,
            player.lastName || null,
            player.fullName || `${player.firstName || ''} ${player.lastName || ''}`.trim(),
            [], // fantasy_positions - TODO: map from provider data if available
            player.position || null,
            player.team || null,
            player.yearsExp || null,
            player.age || null,
            player.active ?? true,
            player.status || null,
            player.injuryStatus || null
          );
          return `($${baseIdx + 1}, $${baseIdx + 2}, $${baseIdx + 3}, $${baseIdx + 4}, $${baseIdx + 5}, $${baseIdx + 6}, $${baseIdx + 7}, $${baseIdx + 8}, $${baseIdx + 9}, $${baseIdx + 10}, $${baseIdx + 11})`;
        })
        .join(', ');

      // First, find or create players by matching on full_name + position
      // This is a simplified approach - in production, you might want more sophisticated matching
      const result = await this.db.query(
        `INSERT INTO players (
          first_name, last_name, full_name, fantasy_positions,
          position, team, years_exp, age, active, status, injury_status
        ) VALUES ${placeholders}
        ON CONFLICT (sleeper_id) DO UPDATE SET
          first_name = EXCLUDED.first_name,
          last_name = EXCLUDED.last_name,
          full_name = EXCLUDED.full_name,
          position = EXCLUDED.position,
          team = EXCLUDED.team,
          years_exp = EXCLUDED.years_exp,
          age = EXCLUDED.age,
          active = EXCLUDED.active,
          status = EXCLUDED.status,
          injury_status = EXCLUDED.injury_status,
          updated_at = CURRENT_TIMESTAMP
        RETURNING id`,
        values
      );

      // Batch upsert external IDs for all players in this batch
      const externalIdMappings = batch.map((player, j) => ({
        playerId: result.rows[j].id as number,
        provider,
        externalId: player.externalId,
      }));
      await externalIdRepo.batchUpsertExternalIds(externalIdMappings);

      totalUpserted += batch.length;
    }

    return totalUpserted;
  }
}
