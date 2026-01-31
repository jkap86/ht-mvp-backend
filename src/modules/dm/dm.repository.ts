import { Pool } from 'pg';
import {
  Conversation,
  ConversationWithDetails,
  DirectMessageWithUser,
} from './dm.model';

export class DmRepository {
  constructor(private readonly pool: Pool) {}

  /**
   * Get or create a conversation between two users.
   * Uses canonical ordering (user1_id < user2_id) to prevent duplicates.
   * Uses INSERT ... ON CONFLICT to handle race conditions atomically.
   */
  async findOrCreateConversation(userId1: string, userId2: string): Promise<Conversation> {
    // Ensure canonical ordering
    const [user1Id, user2Id] =
      userId1 < userId2 ? [userId1, userId2] : [userId2, userId1];

    // Atomic upsert - handles race conditions by using ON CONFLICT
    const result = await this.pool.query(
      `INSERT INTO conversations (user1_id, user2_id)
       VALUES ($1, $2)
       ON CONFLICT (user1_id, user2_id) DO UPDATE SET updated_at = CURRENT_TIMESTAMP
       RETURNING id, user1_id as "user1Id", user2_id as "user2Id",
                 user1_last_read_message_id as "user1LastReadMessageId",
                 user2_last_read_message_id as "user2LastReadMessageId",
                 created_at as "createdAt", updated_at as "updatedAt"`,
      [user1Id, user2Id]
    );

    return result.rows[0];
  }

  /**
   * Get a conversation by ID
   */
  async findById(conversationId: number): Promise<Conversation | null> {
    const result = await this.pool.query(
      `SELECT id, user1_id as "user1Id", user2_id as "user2Id",
              user1_last_read_message_id as "user1LastReadMessageId",
              user2_last_read_message_id as "user2LastReadMessageId",
              created_at as "createdAt", updated_at as "updatedAt"
       FROM conversations
       WHERE id = $1`,
      [conversationId]
    );

    return result.rows[0] || null;
  }

  /**
   * Check if a user is a participant in a conversation
   */
  async isUserParticipant(conversationId: number, userId: string): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT 1 FROM conversations
       WHERE id = $1 AND (user1_id = $2 OR user2_id = $2)`,
      [conversationId, userId]
    );

    return result.rows.length > 0;
  }

  /**
   * Get all conversations for a user with details (other user info, last message, unread count)
   */
  async getConversationsForUser(userId: string): Promise<ConversationWithDetails[]> {
    const result = await this.pool.query(
      `WITH conversation_messages AS (
        SELECT DISTINCT ON (dm.conversation_id)
          dm.conversation_id,
          dm.id as message_id,
          dm.sender_id,
          dm.message,
          dm.created_at,
          u.username as sender_username
        FROM direct_messages dm
        JOIN users u ON dm.sender_id = u.id
        ORDER BY dm.conversation_id, dm.created_at DESC
      ),
      unread_counts AS (
        SELECT
          c.id as conversation_id,
          COUNT(dm.id) as unread_count
        FROM conversations c
        LEFT JOIN direct_messages dm ON dm.conversation_id = c.id
          AND dm.sender_id != $1
          AND dm.id > COALESCE(
            CASE WHEN c.user1_id = $1 THEN c.user1_last_read_message_id
                 ELSE c.user2_last_read_message_id
            END, 0
          )
        WHERE c.user1_id = $1 OR c.user2_id = $1
        GROUP BY c.id
      )
      SELECT
        c.id,
        CASE WHEN c.user1_id = $1 THEN c.user2_id ELSE c.user1_id END as "otherUserId",
        CASE WHEN c.user1_id = $1 THEN u2.username ELSE u1.username END as "otherUsername",
        c.updated_at as "updatedAt",
        cm.message_id as "lastMessageId",
        cm.sender_id as "lastMessageSenderId",
        cm.sender_username as "lastMessageSenderUsername",
        cm.message as "lastMessageText",
        cm.created_at as "lastMessageCreatedAt",
        COALESCE(uc.unread_count, 0)::int as "unreadCount"
      FROM conversations c
      JOIN users u1 ON c.user1_id = u1.id
      JOIN users u2 ON c.user2_id = u2.id
      LEFT JOIN conversation_messages cm ON cm.conversation_id = c.id
      LEFT JOIN unread_counts uc ON uc.conversation_id = c.id
      WHERE c.user1_id = $1 OR c.user2_id = $1
      ORDER BY COALESCE(cm.created_at, c.updated_at) DESC`,
      [userId]
    );

    return result.rows.map((row) => ({
      id: row.id,
      otherUserId: row.otherUserId,
      otherUsername: row.otherUsername,
      updatedAt: row.updatedAt,
      unreadCount: row.unreadCount,
      lastMessage: row.lastMessageId
        ? {
            id: row.lastMessageId,
            conversationId: row.id,
            senderId: row.lastMessageSenderId,
            senderUsername: row.lastMessageSenderUsername,
            message: row.lastMessageText,
            createdAt: row.lastMessageCreatedAt,
          }
        : null,
    }));
  }

  /**
   * Get messages for a conversation with pagination
   */
  async getMessages(
    conversationId: number,
    limit = 50,
    before?: number
  ): Promise<DirectMessageWithUser[]> {
    let query = `
      SELECT
        dm.id,
        dm.conversation_id as "conversationId",
        dm.sender_id as "senderId",
        dm.message,
        dm.created_at as "createdAt",
        u.username as "senderUsername"
      FROM direct_messages dm
      JOIN users u ON dm.sender_id = u.id
      WHERE dm.conversation_id = $1
    `;
    const params: any[] = [conversationId];

    if (before) {
      query += ` AND dm.id < $2`;
      params.push(before);
    }

    query += ` ORDER BY dm.created_at DESC LIMIT $${params.length + 1}`;
    params.push(limit);

    const result = await this.pool.query(query, params);
    return result.rows;
  }

  /**
   * Create a new message in a conversation
   */
  async createMessage(
    conversationId: number,
    senderId: string,
    message: string
  ): Promise<DirectMessageWithUser> {
    // Use CTE to insert and join with users table in one query
    const result = await this.pool.query(
      `WITH inserted AS (
        INSERT INTO direct_messages (conversation_id, sender_id, message)
        VALUES ($1, $2, $3)
        RETURNING id, conversation_id, sender_id, message, created_at
      )
      SELECT
        i.id,
        i.conversation_id as "conversationId",
        i.sender_id as "senderId",
        i.message,
        i.created_at as "createdAt",
        COALESCE(u.username, 'Unknown') as "senderUsername"
      FROM inserted i
      LEFT JOIN users u ON i.sender_id = u.id`,
      [conversationId, senderId, message]
    );

    // Update conversation's updated_at timestamp
    await this.pool.query(
      `UPDATE conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [conversationId]
    );

    return result.rows[0];
  }

  /**
   * Mark messages as read for a user in a conversation
   * Updates the user's last_read_message_id to the latest message
   * Uses atomic query to prevent race conditions
   */
  async markAsRead(conversationId: number, userId: string): Promise<void> {
    // Atomic update - updates the appropriate column based on which user is reading
    // Uses subquery to get latest message ID and CASE to determine which column to update
    await this.pool.query(
      `UPDATE conversations
       SET user1_last_read_message_id = CASE
             WHEN user1_id = $2 THEN (
               SELECT id FROM direct_messages
               WHERE conversation_id = $1
               ORDER BY created_at DESC LIMIT 1
             )
             ELSE user1_last_read_message_id
           END,
           user2_last_read_message_id = CASE
             WHEN user2_id = $2 THEN (
               SELECT id FROM direct_messages
               WHERE conversation_id = $1
               ORDER BY created_at DESC LIMIT 1
             )
             ELSE user2_last_read_message_id
           END
       WHERE id = $1 AND (user1_id = $2 OR user2_id = $2)`,
      [conversationId, userId]
    );
  }

  /**
   * Get the other user ID in a conversation
   */
  getOtherUserId(conversation: Conversation, userId: string): string {
    return conversation.user1Id === userId ? conversation.user2Id : conversation.user1Id;
  }
}
