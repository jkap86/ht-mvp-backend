/**
 * Draft Order Repository
 *
 * Handles draft order management operations including:
 * - Getting/setting draft order
 * - Autodraft settings
 * - Atomic order updates
 */

import type { Pool, PoolClient } from 'pg';
import type { DraftOrderEntry } from '../drafts.model';
import { runInTransaction } from '../../../shared/transaction-runner';
import { buildBatchInsertQuery } from '../../../shared/query-builder';

export class DraftOrderRepository {
  constructor(private readonly db: Pool) {}

  /**
   * Get the draft order with roster and user information.
   */
  async getDraftOrder(
    draftId: number,
    limit?: number,
    offset?: number
  ): Promise<DraftOrderEntry[]> {
    let query = `SELECT dord.*,
       COALESCE(r.settings->>'team_name', u.username, 'Team ' || r.roster_id) as username,
       r.user_id
       FROM draft_order dord
       LEFT JOIN rosters r ON dord.roster_id = r.id
       LEFT JOIN users u ON r.user_id = u.id
       WHERE dord.draft_id = $1
       ORDER BY dord.draft_position`;

    const params: number[] = [draftId];

    if (limit !== undefined) {
      params.push(limit);
      query += ` LIMIT $${params.length}`;
    }

    if (offset !== undefined) {
      params.push(offset);
      query += ` OFFSET $${params.length}`;
    }

    const result = await this.db.query(query, params);
    return result.rows.map((row) => ({
      id: row.id,
      draftId: row.draft_id,
      rosterId: row.roster_id,
      draftPosition: row.draft_position,
      username: row.username,
      isAutodraftEnabled: row.is_autodraft_enabled ?? false,
    }));
  }

  /**
   * Set autodraft enabled/disabled for a roster in a draft.
   */
  async setAutodraftEnabled(draftId: number, rosterId: number, enabled: boolean): Promise<void> {
    await this.db.query(
      `UPDATE draft_order SET is_autodraft_enabled = $1 WHERE draft_id = $2 AND roster_id = $3`,
      [enabled, draftId, rosterId]
    );
  }

  /**
   * Set autodraft enabled/disabled using an existing client (for transactions).
   */
  async setAutodraftEnabledWithClient(
    client: PoolClient,
    draftId: number,
    rosterId: number,
    enabled: boolean
  ): Promise<void> {
    await client.query(
      `UPDATE draft_order SET is_autodraft_enabled = $1 WHERE draft_id = $2 AND roster_id = $3`,
      [enabled, draftId, rosterId]
    );
  }

  /**
   * Get autodraft status for a roster in a draft.
   */
  async getAutodraftEnabled(draftId: number, rosterId: number): Promise<boolean> {
    const result = await this.db.query(
      `SELECT is_autodraft_enabled FROM draft_order WHERE draft_id = $1 AND roster_id = $2`,
      [draftId, rosterId]
    );
    return result.rows.length > 0 ? (result.rows[0].is_autodraft_enabled ?? false) : false;
  }

  /**
   * Create or update a single draft order entry.
   */
  async createDraftOrder(draftId: number, rosterId: number, position: number): Promise<void> {
    await this.db.query(
      `INSERT INTO draft_order (draft_id, roster_id, draft_position)
       VALUES ($1, $2, $3)
       ON CONFLICT (draft_id, roster_id) DO UPDATE SET draft_position = EXCLUDED.draft_position`,
      [draftId, rosterId, position]
    );
  }

  /**
   * Clear all draft order entries for a draft.
   */
  async clearDraftOrder(draftId: number): Promise<void> {
    await this.db.query('DELETE FROM draft_order WHERE draft_id = $1', [draftId]);
  }

  /**
   * Atomically updates the draft order within a transaction.
   * Clears existing order and inserts new positions in a single transaction.
   * @param draftId - The draft ID
   * @param rosterIds - Array of roster IDs in desired order (index 0 = position 1)
   */
  async updateDraftOrderAtomic(draftId: number, rosterIds: number[]): Promise<void> {
    await runInTransaction(this.db, async (client) => {
      // Clear existing order
      await client.query('DELETE FROM draft_order WHERE draft_id = $1', [draftId]);

      // Insert new order using batch insert
      if (rosterIds.length > 0) {
        const rows = rosterIds.map((rosterId, index) => [draftId, rosterId, index + 1]);
        const { query, values } = buildBatchInsertQuery(
          'draft_order',
          ['draft_id', 'roster_id', 'draft_position'],
          rows
        );
        await client.query(query, values);
      }
    });
  }

  /**
   * Atomically updates the draft order within an existing transaction.
   * Clears existing order and inserts new positions using the provided client.
   * @param client - The PoolClient for the existing transaction
   * @param draftId - The draft ID
   * @param rosterIds - Array of roster IDs in desired order (index 0 = position 1)
   */
  async updateDraftOrderAtomicWithClient(
    client: PoolClient,
    draftId: number,
    rosterIds: number[]
  ): Promise<void> {
    // Clear existing order
    await client.query('DELETE FROM draft_order WHERE draft_id = $1', [draftId]);

    // Insert new order using batch insert
    if (rosterIds.length > 0) {
      const rows = rosterIds.map((rosterId, index) => [draftId, rosterId, index + 1]);
      const { query, values } = buildBatchInsertQuery(
        'draft_order',
        ['draft_id', 'roster_id', 'draft_position'],
        rows
      );
      await client.query(query, values);
    }
  }

  /**
   * Get draft order using an existing client (for use within transactions).
   */
  async getDraftOrderWithClient(
    client: PoolClient,
    draftId: number
  ): Promise<DraftOrderEntry[]> {
    const result = await client.query(
      `SELECT dord.*,
       COALESCE(r.settings->>'team_name', u.username, 'Team ' || r.roster_id) as username,
       r.user_id
       FROM draft_order dord
       LEFT JOIN rosters r ON dord.roster_id = r.id
       LEFT JOIN users u ON r.user_id = u.id
       WHERE dord.draft_id = $1
       ORDER BY dord.draft_position`,
      [draftId]
    );
    return result.rows.map((row) => ({
      id: row.id,
      draftId: row.draft_id,
      rosterId: row.roster_id,
      draftPosition: row.draft_position,
      username: row.username,
      isAutodraftEnabled: row.is_autodraft_enabled ?? false,
    }));
  }
}
