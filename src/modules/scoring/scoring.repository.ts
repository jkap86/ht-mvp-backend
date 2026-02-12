import { Pool, PoolClient } from 'pg';
import { PlayerStats, playerStatsFromDatabase } from './scoring.model';
import { runInTransaction } from '../../shared/transaction-runner';

/** All columns needed by playerStatsFromDatabase() */
const STATS_COLUMNS = `
  id, player_id, season, week,
  pass_yards, pass_td, pass_int,
  rush_yards, rush_td,
  receptions, rec_yards, rec_td,
  fumbles_lost, two_pt_conversions,
  fg_made, fg_missed, pat_made, pat_missed,
  def_td, def_int, def_sacks, def_fumble_rec, def_safety, def_points_allowed,
  created_at, updated_at
`.replace(/\s+/g, ' ').trim();

export class PlayerStatsRepository {
  constructor(private readonly db: Pool) {}

  /**
   * Get stats for a player in a specific week
   */
  async findByPlayerAndWeek(
    playerId: number,
    season: number,
    week: number
  ): Promise<PlayerStats | null> {
    const result = await this.db.query(
      `SELECT ${STATS_COLUMNS} FROM player_stats
       WHERE player_id = $1 AND season = $2 AND week = $3`,
      [playerId, season, week]
    );

    if (result.rows.length === 0) return null;
    return playerStatsFromDatabase(result.rows[0]);
  }

  /**
   * Get stats for multiple players in a specific week
   */
  async findByPlayersAndWeek(
    playerIds: number[],
    season: number,
    week: number
  ): Promise<PlayerStats[]> {
    if (playerIds.length === 0) return [];

    const result = await this.db.query(
      `SELECT ${STATS_COLUMNS} FROM player_stats
       WHERE player_id = ANY($1) AND season = $2 AND week = $3`,
      [playerIds, season, week]
    );

    return result.rows.map(playerStatsFromDatabase);
  }

  /**
   * Get all stats for a player in a season
   */
  async findByPlayerAndSeason(playerId: number, season: number): Promise<PlayerStats[]> {
    const result = await this.db.query(
      `SELECT ${STATS_COLUMNS} FROM player_stats
       WHERE player_id = $1 AND season = $2
       ORDER BY week`,
      [playerId, season]
    );

    return result.rows.map(playerStatsFromDatabase);
  }

  /**
   * Upsert player stats (insert or update)
   */
  async upsert(
    stats: Partial<PlayerStats> & { playerId: number; season: number; week: number },
    client?: PoolClient
  ): Promise<PlayerStats> {
    const db = client || this.db;
    const result = await db.query(
      `INSERT INTO player_stats (
        player_id, season, week,
        pass_yards, pass_td, pass_int,
        rush_yards, rush_td,
        receptions, rec_yards, rec_td,
        fumbles_lost, two_pt_conversions,
        fg_made, fg_missed, pat_made, pat_missed,
        def_td, def_int, def_sacks, def_fumble_rec, def_safety, def_points_allowed
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)
      ON CONFLICT (player_id, season, week)
      DO UPDATE SET
        pass_yards = EXCLUDED.pass_yards,
        pass_td = EXCLUDED.pass_td,
        pass_int = EXCLUDED.pass_int,
        rush_yards = EXCLUDED.rush_yards,
        rush_td = EXCLUDED.rush_td,
        receptions = EXCLUDED.receptions,
        rec_yards = EXCLUDED.rec_yards,
        rec_td = EXCLUDED.rec_td,
        fumbles_lost = EXCLUDED.fumbles_lost,
        two_pt_conversions = EXCLUDED.two_pt_conversions,
        fg_made = EXCLUDED.fg_made,
        fg_missed = EXCLUDED.fg_missed,
        pat_made = EXCLUDED.pat_made,
        pat_missed = EXCLUDED.pat_missed,
        def_td = EXCLUDED.def_td,
        def_int = EXCLUDED.def_int,
        def_sacks = EXCLUDED.def_sacks,
        def_fumble_rec = EXCLUDED.def_fumble_rec,
        def_safety = EXCLUDED.def_safety,
        def_points_allowed = EXCLUDED.def_points_allowed,
        updated_at = CURRENT_TIMESTAMP
      RETURNING ${STATS_COLUMNS}`,
      [
        stats.playerId,
        stats.season,
        stats.week,
        stats.passYards || 0,
        stats.passTd || 0,
        stats.passInt || 0,
        stats.rushYards || 0,
        stats.rushTd || 0,
        stats.receptions || 0,
        stats.recYards || 0,
        stats.recTd || 0,
        stats.fumblesLost || 0,
        stats.twoPtConversions || 0,
        stats.fgMade || 0,
        stats.fgMissed || 0,
        stats.patMade || 0,
        stats.patMissed || 0,
        stats.defTd || 0,
        stats.defInt || 0,
        stats.defSacks || 0,
        stats.defFumbleRec || 0,
        stats.defSafety || 0,
        stats.defPointsAllowed || 0,
      ]
    );

    return playerStatsFromDatabase(result.rows[0]);
  }

  /**
   * Bulk upsert player stats
   */
  async bulkUpsert(
    statsList: Array<Partial<PlayerStats> & { playerId: number; season: number; week: number }>
  ): Promise<void> {
    if (statsList.length === 0) return;

    await runInTransaction(this.db, async (client) => {
      const columns = [
        'player_id', 'season', 'week',
        'pass_yards', 'pass_td', 'pass_int',
        'rush_yards', 'rush_td',
        'receptions', 'rec_yards', 'rec_td',
        'fumbles_lost', 'two_pt_conversions',
        'fg_made', 'fg_missed', 'pat_made', 'pat_missed',
        'def_td', 'def_int', 'def_sacks', 'def_fumble_rec', 'def_safety', 'def_points_allowed',
      ];

      const values: any[] = [];
      const placeholders: string[] = [];
      let paramIndex = 1;

      for (const stats of statsList) {
        const row = [
          stats.playerId,
          stats.season,
          stats.week,
          stats.passYards || 0,
          stats.passTd || 0,
          stats.passInt || 0,
          stats.rushYards || 0,
          stats.rushTd || 0,
          stats.receptions || 0,
          stats.recYards || 0,
          stats.recTd || 0,
          stats.fumblesLost || 0,
          stats.twoPtConversions || 0,
          stats.fgMade || 0,
          stats.fgMissed || 0,
          stats.patMade || 0,
          stats.patMissed || 0,
          stats.defTd || 0,
          stats.defInt || 0,
          stats.defSacks || 0,
          stats.defFumbleRec || 0,
          stats.defSafety || 0,
          stats.defPointsAllowed || 0,
        ];
        const rowPlaceholders = row.map(() => `$${paramIndex++}`);
        placeholders.push(`(${rowPlaceholders.join(', ')})`);
        values.push(...row);
      }

      const query = `INSERT INTO player_stats (${columns.join(', ')})
        VALUES ${placeholders.join(', ')}
        ON CONFLICT (player_id, season, week)
        DO UPDATE SET
          pass_yards = EXCLUDED.pass_yards,
          pass_td = EXCLUDED.pass_td,
          pass_int = EXCLUDED.pass_int,
          rush_yards = EXCLUDED.rush_yards,
          rush_td = EXCLUDED.rush_td,
          receptions = EXCLUDED.receptions,
          rec_yards = EXCLUDED.rec_yards,
          rec_td = EXCLUDED.rec_td,
          fumbles_lost = EXCLUDED.fumbles_lost,
          two_pt_conversions = EXCLUDED.two_pt_conversions,
          fg_made = EXCLUDED.fg_made,
          fg_missed = EXCLUDED.fg_missed,
          pat_made = EXCLUDED.pat_made,
          pat_missed = EXCLUDED.pat_missed,
          def_td = EXCLUDED.def_td,
          def_int = EXCLUDED.def_int,
          def_sacks = EXCLUDED.def_sacks,
          def_fumble_rec = EXCLUDED.def_fumble_rec,
          def_safety = EXCLUDED.def_safety,
          def_points_allowed = EXCLUDED.def_points_allowed,
          updated_at = CURRENT_TIMESTAMP`;

      await client.query(query, values);
    });
  }
}
