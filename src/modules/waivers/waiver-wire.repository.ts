import { Pool, PoolClient } from 'pg';
import {
  WaiverWirePlayer,
  WaiverWirePlayerWithDetails,
  waiverWirePlayerFromDatabase,
} from './waivers.model';

/**
 * Repository for waiver wire (recently dropped players)
 */
export class WaiverWireRepository {
  constructor(private readonly db: Pool) {}

  /**
   * Add player to waiver wire
   */
  async addPlayer(
    leagueId: number,
    playerId: number,
    droppedByRosterId: number | null,
    expiresAt: Date,
    season: number,
    week: number,
    client?: PoolClient
  ): Promise<WaiverWirePlayer> {
    const conn = client || this.db;

    // Upsert - update expiration if already on waivers
    const result = await conn.query(
      `INSERT INTO waiver_wire (league_id, player_id, dropped_by_roster_id, waiver_expires_at, season, week)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (league_id, player_id)
       DO UPDATE SET waiver_expires_at = $4, dropped_by_roster_id = $3, season = $5, week = $6
       RETURNING *`,
      [leagueId, playerId, droppedByRosterId, expiresAt, season, week]
    );
    return waiverWirePlayerFromDatabase(result.rows[0]);
  }

  /**
   * Remove player from waiver wire
   */
  async removePlayer(leagueId: number, playerId: number, client?: PoolClient): Promise<boolean> {
    const conn = client || this.db;
    const result = await conn.query(
      'DELETE FROM waiver_wire WHERE league_id = $1 AND player_id = $2',
      [leagueId, playerId]
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Check if player is on waiver wire
   */
  async isOnWaivers(leagueId: number, playerId: number, client?: PoolClient): Promise<boolean> {
    const conn = client || this.db;
    const result = await conn.query(
      `SELECT 1 FROM waiver_wire
       WHERE league_id = $1 AND player_id = $2 AND waiver_expires_at > NOW()`,
      [leagueId, playerId]
    );
    return result.rows.length > 0;
  }

  /**
   * Get waiver wire expiration for a player
   */
  async getPlayerExpiration(leagueId: number, playerId: number, client?: PoolClient): Promise<Date | null> {
    const conn = client || this.db;
    const result = await conn.query(
      'SELECT waiver_expires_at FROM waiver_wire WHERE league_id = $1 AND player_id = $2',
      [leagueId, playerId]
    );
    return result.rows.length > 0 ? result.rows[0].waiver_expires_at : null;
  }

  /**
   * Get all players on waiver wire for a league
   */
  async getByLeague(leagueId: number): Promise<WaiverWirePlayerWithDetails[]> {
    const result = await this.db.query(
      `SELECT ww.*,
        p.full_name as player_name,
        p.position as player_position,
        p.team as player_team,
        r.settings->>'team_name' as dropped_by_team_name
      FROM waiver_wire ww
      JOIN players p ON p.id = ww.player_id
      LEFT JOIN rosters r ON r.id = ww.dropped_by_roster_id
      WHERE ww.league_id = $1 AND ww.waiver_expires_at > NOW()
      ORDER BY ww.waiver_expires_at ASC`,
      [leagueId]
    );

    return result.rows.map(row => ({
      ...waiverWirePlayerFromDatabase(row),
      playerName: row.player_name || 'Unknown',
      playerPosition: row.player_position,
      playerTeam: row.player_team,
      droppedByTeamName: row.dropped_by_team_name,
    }));
  }

  /**
   * Clean up expired waiver wire entries
   */
  async removeExpired(client?: PoolClient): Promise<number> {
    const conn = client || this.db;
    const result = await conn.query(
      'DELETE FROM waiver_wire WHERE waiver_expires_at <= NOW()'
    );
    return result.rowCount ?? 0;
  }
}
