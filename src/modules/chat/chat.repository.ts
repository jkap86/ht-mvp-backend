import { Pool } from 'pg';
import { ChatMessage, ChatMessageWithUser } from './chat.model';

export class ChatRepository {
  constructor(private readonly pool: Pool) {}

  async create(leagueId: number, userId: string, message: string): Promise<ChatMessageWithUser> {
    const result = await this.pool.query(
      `INSERT INTO league_chat_messages (league_id, user_id, message)
       VALUES ($1, $2, $3)
       RETURNING id, league_id as "leagueId", user_id as "userId", message, created_at as "createdAt"`,
      [leagueId, userId, message]
    );

    const msg = result.rows[0];

    // Get username
    const userResult = await this.pool.query(
      'SELECT username FROM users WHERE id = $1',
      [userId]
    );

    return {
      ...msg,
      username: userResult.rows[0]?.username || 'Unknown',
    };
  }

  async findByLeagueId(leagueId: number, limit = 50, before?: number): Promise<ChatMessageWithUser[]> {
    let query = `
      SELECT
        m.id,
        m.league_id as "leagueId",
        m.user_id as "userId",
        m.message,
        m.created_at as "createdAt",
        u.username
      FROM league_chat_messages m
      JOIN users u ON m.user_id = u.id
      WHERE m.league_id = $1
    `;
    const params: any[] = [leagueId];

    if (before) {
      query += ` AND m.id < $2`;
      params.push(before);
    }

    query += ` ORDER BY m.created_at DESC LIMIT $${params.length + 1}`;
    params.push(limit);

    const result = await this.pool.query(query, params);
    return result.rows;
  }

  async deleteByLeagueId(leagueId: number): Promise<void> {
    await this.pool.query('DELETE FROM league_chat_messages WHERE league_id = $1', [leagueId]);
  }
}
