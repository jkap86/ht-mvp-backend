import { Pool } from 'pg';
import { ChatMessageWithUser, MessageType, SystemMessageMetadata } from './chat.model';

export class ChatRepository {
  constructor(private readonly pool: Pool) {}

  async create(leagueId: number, userId: string, message: string): Promise<ChatMessageWithUser> {
    // Single query using CTE to INSERT and JOIN with users table
    const result = await this.pool.query(
      `WITH inserted AS (
        INSERT INTO league_chat_messages (league_id, user_id, message, message_type)
        VALUES ($1, $2, $3, 'chat')
        RETURNING id, league_id, user_id, message, message_type, metadata, created_at
      )
      SELECT
        i.id,
        i.league_id as "leagueId",
        i.user_id as "userId",
        i.message,
        i.message_type as "messageType",
        i.metadata,
        i.created_at as "createdAt",
        COALESCE(u.username, 'Unknown') as username
      FROM inserted i
      LEFT JOIN users u ON i.user_id = u.id`,
      [leagueId, userId, message]
    );

    return result.rows[0];
  }

  /**
   * Create a system message (no user, specific message type)
   */
  async createSystemMessage(
    leagueId: number,
    messageType: MessageType,
    message: string,
    metadata?: SystemMessageMetadata
  ): Promise<ChatMessageWithUser> {
    const result = await this.pool.query(
      `INSERT INTO league_chat_messages (league_id, user_id, message, message_type, metadata)
       VALUES ($1, NULL, $2, $3, $4)
       RETURNING
         id,
         league_id as "leagueId",
         user_id as "userId",
         message,
         message_type as "messageType",
         metadata,
         created_at as "createdAt",
         NULL as username`,
      [leagueId, message, messageType, metadata ? JSON.stringify(metadata) : null]
    );

    return result.rows[0];
  }

  async findByLeagueId(
    leagueId: number,
    limit = 50,
    before?: number
  ): Promise<ChatMessageWithUser[]> {
    let query = `
      SELECT
        m.id,
        m.league_id as "leagueId",
        m.user_id as "userId",
        m.message,
        m.message_type as "messageType",
        m.metadata,
        m.created_at as "createdAt",
        u.username
      FROM league_chat_messages m
      LEFT JOIN users u ON m.user_id = u.id
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
