import { Pool, PoolClient } from 'pg';
import { TradeBlockItemWithDetails } from './trade-block.model';

export class TradeBlockRepository {
  constructor(private readonly db: Pool) {}

  async getByLeague(leagueId: number): Promise<TradeBlockItemWithDetails[]> {
    const result = await this.db.query(
      `SELECT tb.*,
              p.full_name, p.position, p.team,
              r.team_name, u.username
       FROM trade_block_items tb
       JOIN players p ON tb.player_id = p.id
       JOIN rosters r ON tb.roster_id = r.id
       JOIN users u ON r.user_id = u.id
       WHERE tb.league_id = $1
       ORDER BY tb.created_at DESC`,
      [leagueId]
    );

    return result.rows.map(this.mapRow);
  }

  async getByRoster(rosterId: number): Promise<TradeBlockItemWithDetails[]> {
    const result = await this.db.query(
      `SELECT tb.*,
              p.full_name, p.position, p.team,
              r.team_name, u.username
       FROM trade_block_items tb
       JOIN players p ON tb.player_id = p.id
       JOIN rosters r ON tb.roster_id = r.id
       JOIN users u ON r.user_id = u.id
       WHERE tb.roster_id = $1
       ORDER BY tb.created_at DESC`,
      [rosterId]
    );

    return result.rows.map(this.mapRow);
  }

  async add(
    client: PoolClient,
    leagueId: number,
    rosterId: number,
    playerId: number,
    note: string | null
  ): Promise<TradeBlockItemWithDetails> {
    const result = await client.query(
      `WITH inserted AS (
        INSERT INTO trade_block_items (league_id, roster_id, player_id, note)
        VALUES ($1, $2, $3, $4)
        RETURNING *
      )
      SELECT i.*,
             p.full_name, p.position, p.team,
             r.team_name, u.username
      FROM inserted i
      JOIN players p ON i.player_id = p.id
      JOIN rosters r ON i.roster_id = r.id
      JOIN users u ON r.user_id = u.id`,
      [leagueId, rosterId, playerId, note]
    );

    return this.mapRow(result.rows[0]);
  }

  async remove(client: PoolClient, leagueId: number, rosterId: number, playerId: number): Promise<boolean> {
    const result = await client.query(
      `DELETE FROM trade_block_items
       WHERE league_id = $1 AND roster_id = $2 AND player_id = $3`,
      [leagueId, rosterId, playerId]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async removePlayerFromRoster(client: PoolClient, rosterId: number, playerId: number): Promise<void> {
    await client.query(
      `DELETE FROM trade_block_items
       WHERE roster_id = $1 AND player_id = $2`,
      [rosterId, playerId]
    );
  }

  private mapRow(row: any): TradeBlockItemWithDetails {
    return {
      id: row.id,
      leagueId: row.league_id,
      rosterId: row.roster_id,
      playerId: row.player_id,
      note: row.note || null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      fullName: row.full_name,
      position: row.position,
      team: row.team,
      teamName: row.team_name,
      username: row.username,
    };
  }
}
