/**
 * Draft Chess Clock Repository
 *
 * Manages per-manager time budgets for chess clock draft mode.
 * Uses atomic SQL operations to prevent race conditions on time deduction.
 */

import type { Pool, PoolClient } from 'pg';

export class DraftChessClockRepository {
  constructor(private readonly db: Pool) {}

  /**
   * Initialize chess clock entries for all rosters in a draft.
   * Must be called within a transaction (uses client).
   */
  async initializeWithClient(
    client: PoolClient,
    draftId: number,
    rosterIds: number[],
    totalSeconds: number
  ): Promise<void> {
    if (rosterIds.length === 0) return;

    const values: any[] = [];
    const placeholders: string[] = [];
    let paramIdx = 1;

    for (const rosterId of rosterIds) {
      placeholders.push(`($${paramIdx}, $${paramIdx + 1}, $${paramIdx + 2})`);
      values.push(draftId, rosterId, totalSeconds);
      paramIdx += 3;
    }

    await client.query(
      `INSERT INTO draft_chess_clocks (draft_id, roster_id, remaining_seconds)
       VALUES ${placeholders.join(', ')}
       ON CONFLICT (draft_id, roster_id) DO NOTHING`,
      values
    );
  }

  /**
   * Get all chess clock entries for a draft as a map of rosterId -> remainingSeconds.
   * Uses existing client for transaction consistency.
   */
  async getClockMapWithClient(
    client: PoolClient,
    draftId: number
  ): Promise<Record<number, number>> {
    const result = await client.query(
      'SELECT roster_id, remaining_seconds FROM draft_chess_clocks WHERE draft_id = $1',
      [draftId]
    );

    const map: Record<number, number> = {};
    for (const row of result.rows) {
      map[row.roster_id] = parseFloat(row.remaining_seconds);
    }
    return map;
  }

  /**
   * Get all chess clock entries for a draft as a map (pool-based for reads).
   */
  async getClockMap(draftId: number): Promise<Record<number, number>> {
    const result = await this.db.query(
      'SELECT roster_id, remaining_seconds FROM draft_chess_clocks WHERE draft_id = $1',
      [draftId]
    );

    const map: Record<number, number> = {};
    for (const row of result.rows) {
      map[row.roster_id] = parseFloat(row.remaining_seconds);
    }
    return map;
  }

  /**
   * Get remaining seconds for a specific roster in a draft.
   * Uses existing client for transaction consistency.
   */
  async getRemainingWithClient(
    client: PoolClient,
    draftId: number,
    rosterId: number
  ): Promise<number> {
    const result = await client.query(
      'SELECT remaining_seconds FROM draft_chess_clocks WHERE draft_id = $1 AND roster_id = $2',
      [draftId, rosterId]
    );

    if (result.rows.length === 0) {
      return 0;
    }
    return parseFloat(result.rows[0].remaining_seconds);
  }

  /**
   * Deduct elapsed time from a roster's chess clock budget.
   * Uses GREATEST(0, ...) to prevent negative values.
   * Returns the new remaining seconds.
   */
  async deductTimeWithClient(
    client: PoolClient,
    draftId: number,
    rosterId: number,
    elapsedSeconds: number
  ): Promise<number> {
    const result = await client.query(
      `UPDATE draft_chess_clocks
       SET remaining_seconds = GREATEST(0, remaining_seconds - $1)
       WHERE draft_id = $2 AND roster_id = $3
       RETURNING remaining_seconds`,
      [elapsedSeconds, draftId, rosterId]
    );

    if (result.rows.length === 0) {
      return 0;
    }
    return parseFloat(result.rows[0].remaining_seconds);
  }

  /**
   * Restore time to a roster's chess clock budget (for undo support).
   * Returns the new remaining seconds.
   */
  async restoreTimeWithClient(
    client: PoolClient,
    draftId: number,
    rosterId: number,
    seconds: number
  ): Promise<number> {
    const result = await client.query(
      `UPDATE draft_chess_clocks
       SET remaining_seconds = remaining_seconds + $1
       WHERE draft_id = $2 AND roster_id = $3
       RETURNING remaining_seconds`,
      [seconds, draftId, rosterId]
    );

    if (result.rows.length === 0) {
      return 0;
    }
    return parseFloat(result.rows[0].remaining_seconds);
  }
}
