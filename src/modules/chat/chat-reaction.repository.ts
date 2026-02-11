import { Pool } from 'pg';

export interface ReactionGroup {
  emoji: string;
  count: number;
  users: string[];
  hasReacted: boolean;
}

export interface ReactionRow {
  messageId: number;
  emoji: string;
  userId: string;
}

export class ChatReactionRepository {
  constructor(private readonly pool: Pool) {}

  /**
   * Add a reaction to a league chat message.
   * Uses ON CONFLICT to ignore duplicate reactions.
   */
  async addReaction(messageId: number, userId: string, emoji: string): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO league_chat_reactions (message_id, user_id, emoji)
       VALUES ($1, $2, $3)
       ON CONFLICT (message_id, user_id, emoji) DO NOTHING
       RETURNING id`,
      [messageId, userId, emoji]
    );
    return result.rowCount > 0;
  }

  /**
   * Remove a reaction from a league chat message.
   */
  async removeReaction(messageId: number, userId: string, emoji: string): Promise<boolean> {
    const result = await this.pool.query(
      `DELETE FROM league_chat_reactions
       WHERE message_id = $1 AND user_id = $2 AND emoji = $3`,
      [messageId, userId, emoji]
    );
    return result.rowCount > 0;
  }

  /**
   * Get all reactions for a set of message IDs, grouped by message and emoji.
   */
  async getReactionsForMessages(messageIds: number[]): Promise<Map<number, ReactionRow[]>> {
    if (messageIds.length === 0) return new Map();

    const result = await this.pool.query(
      `SELECT message_id as "messageId", emoji, user_id as "userId"
       FROM league_chat_reactions
       WHERE message_id = ANY($1)
       ORDER BY message_id, emoji, created_at`,
      [messageIds]
    );

    const map = new Map<number, ReactionRow[]>();
    for (const row of result.rows) {
      const existing = map.get(row.messageId) || [];
      existing.push(row);
      map.set(row.messageId, existing);
    }
    return map;
  }

  /**
   * Get aggregated reactions for a single message.
   */
  async getReactionsForMessage(messageId: number): Promise<ReactionRow[]> {
    const result = await this.pool.query(
      `SELECT message_id as "messageId", emoji, user_id as "userId"
       FROM league_chat_reactions
       WHERE message_id = $1
       ORDER BY emoji, created_at`,
      [messageId]
    );
    return result.rows;
  }

  /**
   * Verify that a message belongs to a specific league.
   */
  async getMessageLeagueId(messageId: number): Promise<number | null> {
    const result = await this.pool.query(
      `SELECT league_id FROM league_chat_messages WHERE id = $1`,
      [messageId]
    );
    return result.rows[0]?.league_id ?? null;
  }
}

/**
 * Group raw reaction rows into aggregated reaction groups.
 */
export function groupReactions(rows: ReactionRow[], currentUserId?: string): ReactionGroup[] {
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
    hasReacted: currentUserId ? users.includes(currentUserId) : false,
  }));
}
