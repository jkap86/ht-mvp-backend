import { Pool, PoolClient } from 'pg';
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
    metadata?: SystemMessageMetadata,
    client?: PoolClient
  ): Promise<ChatMessageWithUser> {
    const db = client || this.pool;
    const result = await db.query(
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

    query += ` ORDER BY m.id DESC LIMIT $${params.length + 1}`;
    params.push(limit);

    const result = await this.pool.query(query, params);
    return result.rows;
  }

  /**
   * Mark league chat as read for a user (upsert last-read cursor to latest message)
   */
  async markAsRead(leagueId: number, userId: string): Promise<{ changed: boolean }> {
    const result = await this.pool.query(
      `INSERT INTO league_chat_read_state (league_id, user_id, last_read_message_id, updated_at)
       SELECT $1, $2, MAX(id), NOW()
       FROM league_chat_messages
       WHERE league_id = $1
       ON CONFLICT (league_id, user_id) DO UPDATE SET
         last_read_message_id = GREATEST(
           league_chat_read_state.last_read_message_id,
           EXCLUDED.last_read_message_id
         ),
         updated_at = NOW()
       WHERE league_chat_read_state.last_read_message_id IS DISTINCT FROM
         GREATEST(league_chat_read_state.last_read_message_id, EXCLUDED.last_read_message_id)`,
      [leagueId, userId]
    );
    return { changed: (result.rowCount ?? 0) > 0 };
  }

  /**
   * Get unread message count for a user in a league
   */
  async getUnreadCount(leagueId: number, userId: string): Promise<number> {
    const result = await this.pool.query(
      `SELECT COUNT(*) as count
       FROM league_chat_messages m
       WHERE m.league_id = $1
         AND m.id > COALESCE(
           (SELECT last_read_message_id FROM league_chat_read_state
            WHERE league_id = $1 AND user_id = $2),
           0
         )
         AND (m.user_id IS NULL OR m.user_id != $2)`,
      [leagueId, userId]
    );
    return parseInt(result.rows[0].count, 10);
  }

  /**
   * Get unread counts for all leagues a user belongs to
   */
  async getUnreadCountsForUser(userId: string): Promise<Array<{ leagueId: number; unreadCount: number }>> {
    const result = await this.pool.query(
      `SELECT r.league_id as "leagueId",
              COUNT(m.id) as "unreadCount"
       FROM rosters r
       LEFT JOIN league_chat_read_state lcrs
         ON lcrs.league_id = r.league_id AND lcrs.user_id = $1
       LEFT JOIN league_chat_messages m
         ON m.league_id = r.league_id
         AND m.id > COALESCE(lcrs.last_read_message_id, 0)
         AND (m.user_id IS NULL OR m.user_id != $1)
       WHERE r.user_id = $1
       GROUP BY r.league_id`,
      [userId]
    );
    return result.rows.map((row) => ({
      leagueId: row.leagueId,
      unreadCount: parseInt(row.unreadCount, 10),
    }));
  }

  async deleteByLeagueId(leagueId: number): Promise<void> {
    await this.pool.query('DELETE FROM league_chat_messages WHERE league_id = $1', [leagueId]);
  }

  /**
   * Search messages in a league using full-text search
   */
  async searchMessages(
    leagueId: number,
    searchQuery: string,
    limit = 100,
    offset = 0
  ): Promise<{ messages: ChatMessageWithUser[]; total: number }> {
    // Get total count first
    const countResult = await this.pool.query(
      `SELECT COUNT(*) as total
       FROM league_chat_messages m
       WHERE m.league_id = $1
         AND to_tsvector('english', m.message) @@ plainto_tsquery('english', $2)`,
      [leagueId, searchQuery]
    );

    const total = parseInt(countResult.rows[0].total, 10);

    // Get paginated results
    const result = await this.pool.query(
      `SELECT
        m.id,
        m.league_id as "leagueId",
        m.user_id as "userId",
        m.message,
        m.message_type as "messageType",
        m.metadata,
        m.created_at as "createdAt",
        u.username,
        ts_rank(to_tsvector('english', m.message), plainto_tsquery('english', $2)) as relevance
      FROM league_chat_messages m
      LEFT JOIN users u ON m.user_id = u.id
      WHERE m.league_id = $1
        AND to_tsvector('english', m.message) @@ plainto_tsquery('english', $2)
      ORDER BY relevance DESC, m.created_at DESC
      LIMIT $3 OFFSET $4`,
      [leagueId, searchQuery, limit, offset]
    );

    return {
      messages: result.rows,
      total,
    };
  }

  /**
   * Get messages around a specific timestamp (for date jump navigation)
   * Returns messages before and after the timestamp
   */
  async getMessagesAroundTimestamp(
    leagueId: number,
    timestamp: Date,
    limit = 50
  ): Promise<ChatMessageWithUser[]> {
    const halfLimit = Math.floor(limit / 2);

    // Get messages before the timestamp
    const beforeQuery = await this.pool.query(
      `SELECT
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
      WHERE m.league_id = $1 AND m.created_at < $2
      ORDER BY m.created_at DESC
      LIMIT $3`,
      [leagueId, timestamp, halfLimit]
    );

    // Get messages at or after the timestamp
    const afterQuery = await this.pool.query(
      `SELECT
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
      WHERE m.league_id = $1 AND m.created_at >= $2
      ORDER BY m.created_at ASC
      LIMIT $3`,
      [leagueId, timestamp, halfLimit]
    );

    // Combine results and sort by timestamp descending (newest first)
    const messages = [...beforeQuery.rows, ...afterQuery.rows.reverse()];
    return messages;
  }
}
