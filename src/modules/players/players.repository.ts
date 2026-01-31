import { Pool } from 'pg';
import { Player, playerFromDatabase } from './players.model';
import { SleeperPlayer } from './sleeper.client';
import { CFBDPlayer } from './cfbd.client';

export class PlayerRepository {
  constructor(private readonly db: Pool) {}

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

  async findBySleeperId(sleeperId: string): Promise<Player | null> {
    const result = await this.db.query('SELECT * FROM players WHERE sleeper_id = $1', [sleeperId]);
    return result.rows.length > 0 ? playerFromDatabase(result.rows[0]) : null;
  }

  async search(
    query: string,
    position?: string,
    team?: string,
    playerType?: 'nfl' | 'college',
    limit = 50
  ): Promise<Player[]> {
    let sql = `SELECT * FROM players WHERE active = true AND LOWER(full_name) LIKE LOWER($1)`;
    const params: any[] = [`%${query}%`];
    let paramIndex = 2;

    if (position) {
      sql += ` AND position = $${paramIndex++}`;
      params.push(position);
    }

    if (team) {
      sql += ` AND team = $${paramIndex++}`;
      params.push(team);
    }

    if (playerType) {
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
    return parseInt(result.rows[0].count, 10);
  }

  /**
   * Get mapping of sleeper_id to internal player_id for all players
   * Used for efficient bulk stats syncing
   */
  async getSleeperIdMap(): Promise<Map<string, number>> {
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
          const baseIdx = idx * 11;
          const fullName = `${player.first_name || ''} ${player.last_name || ''}`.trim() || 'Unknown';
          // Convert height from inches to display format (e.g., "6-2")
          const heightDisplay = player.height
            ? `${Math.floor(player.height / 12)}-${player.height % 12}`
            : null;

          values.push(
            player.id, // cfbd_id
            player.first_name || null,
            player.last_name || null,
            fullName,
            player.position || null,
            player.team || null, // team name as stored in CFBD
            player.jersey || null,
            player.team || null, // college (same as team for college players)
            heightDisplay,
            player.weight || null,
            player.home_city || null,
            player.home_state || null
          );
          return `($${baseIdx + 1}, $${baseIdx + 2}, $${baseIdx + 3}, $${baseIdx + 4}, $${baseIdx + 5}, $${baseIdx + 6}, $${baseIdx + 7}, $${baseIdx + 8}, $${baseIdx + 9}, $${baseIdx + 10}, $${baseIdx + 11}, $${baseIdx + 12})`;
        })
        .join(', ');

      await this.db.query(
        `INSERT INTO players (
          cfbd_id, first_name, last_name, full_name, position, team,
          jersey_number, college, height, weight, home_city, home_state
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
    return parseInt(result.rows[0].count, 10);
  }
}
