import { Pool } from 'pg';

export interface DmReactionRow {
  messageId: number;
  emoji: string;
  userId: string;
}

export interface DmReactionGroup {
  emoji: string;
  count: number;
  users: string[];
}

export class DmReactionRepository {
  constructor(private readonly pool: Pool) {}

  /**
   * Add a reaction to a DM message.
   * Uses ON CONFLICT to ignore duplicate reactions.
   */
  async addReaction(messageId: number, userId: string, emoji: string): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO dm_message_reactions (message_id, user_id, emoji)
       VALUES ($1, $2, $3)
       ON CONFLICT (message_id, user_id, emoji) DO NOTHING
       RETURNING id`,
      [messageId, userId, emoji]
    );
    return result.rowCount > 0;
  }

  /**
   * Remove a reaction from a DM message.
   */
  async removeReaction(messageId: number, userId: string, emoji: string): Promise<boolean> {
    const result = await this.pool.query(
      `DELETE FROM dm_message_reactions
       WHERE message_id = $1 AND user_id = $2 AND emoji = $3`,
      [messageId, userId, emoji]
    );
    return result.rowCount > 0;
  }

  /**
   * Get all reactions for a set of message IDs.
   */
  async getReactionsForMessages(messageIds: number[]): Promise<Map<number, DmReactionRow[]>> {
    if (messageIds.length === 0) return new Map();

    const result = await this.pool.query(
      `SELECT message_id as "messageId", emoji, user_id as "userId"
       FROM dm_message_reactions
       WHERE message_id = ANY($1)
       ORDER BY message_id, emoji, created_at`,
      [messageIds]
    );

    const map = new Map<number, DmReactionRow[]>();
    for (const row of result.rows) {
      const existing = map.get(row.messageId) || [];
      existing.push(row);
      map.set(row.messageId, existing);
    }
    return map;
  }

  /**
   * Get the conversation ID for a DM message (for authorization).
   */
  async getMessageConversationId(messageId: number): Promise<number | null> {
    const result = await this.pool.query(
      `SELECT conversation_id FROM direct_messages WHERE id = $1`,
      [messageId]
    );
    return result.rows[0]?.conversation_id ?? null;
  }
}

/**
 * Group raw DM reaction rows into aggregated reaction groups.
 */
export function groupDmReactions(rows: DmReactionRow[]): DmReactionGroup[] {
  const emojiMap = new Map<string, string[]>();

  for (const row of rows) {
    const users = emojiMap.get(row.emoji) || [];
    users.push(row.userId);
    emojiMap.set(row.emoji, users);
  }

  return Array.from(emojiMap.entries()).map(([emoji, users]) => ({
    emoji,
    count: users.length,
    users,
  }));
}
