/**
 * Matchup Draft Repository
 *
 * Handles matchup draft pick operations including:
 * - Creating matchup picks with reciprocal entries
 * - Atomic pick + state advance transactions
 * - Available matchup queries
 */

import type { Pool, PoolClient } from 'pg';
import type { Draft } from '../drafts.model';
import { draftFromDatabase } from '../drafts.model';
import { ConflictException, ValidationException } from '../../../utils/exceptions';
import { getLockId, LockDomain } from '../../../shared/locks';
import { runWithLock } from '../../../shared/transaction-runner';
import { logger } from '../../../config/logger.config';

export interface MatchupPickMetadata {
  week: number;
  opponentRosterId: number;
}

export interface MatchupPickResult {
  pickId: number;
  reciprocalPickId: number;
  week: number;
  pickedAt: Date;
}

export class MatchupDraftRepository {
  constructor(private readonly db: Pool) {}

  /**
   * Make a matchup pick and advance draft state atomically.
   * Creates TWO draft_picks entries (picker and opponent) and advances to next pick.
   *
   * LOCK CONTRACT: Acquires DRAFT advisory lock for the duration of the transaction.
   */
  async makeMatchupPickAndAdvanceTx(params: {
    draftId: number;
    expectedPickNumber: number;
    round: number;
    pickInRound: number;
    rosterId: number;
    week: number;
    opponentRosterId: number;
    nextPickState: {
      currentPick: number | null;
      currentRound: number | null;
      currentRosterId: number | null;
      pickDeadline: Date | null;
      status?: 'in_progress' | 'completed';
      completedAt?: Date | null;
    };
    idempotencyKey?: string;
    isAutoPick?: boolean;
  }): Promise<{ result: MatchupPickResult; draft: Draft }> {
    return runWithLock(this.db, LockDomain.DRAFT, params.draftId, (client) =>
      this.makeMatchupPickAndAdvanceTxWithClient(client, params)
    );
  }

  /**
   * Make a matchup pick using an existing client that already holds the draft lock.
   * Creates reciprocal matchup entries for both teams involved.
   */
  async makeMatchupPickAndAdvanceTxWithClient(
    client: PoolClient,
    params: {
      draftId: number;
      expectedPickNumber: number;
      round: number;
      pickInRound: number;
      rosterId: number;
      week: number;
      opponentRosterId: number;
      nextPickState: {
        currentPick: number | null;
        currentRound: number | null;
        currentRosterId: number | null;
        pickDeadline: Date | null;
        status?: 'in_progress' | 'completed';
        completedAt?: Date | null;
      };
      idempotencyKey?: string;
      isAutoPick?: boolean;
    }
  ): Promise<{ result: MatchupPickResult; draft: Draft }> {
    // Re-read draft row FOR UPDATE and validate current state
    const draftResult = await client.query('SELECT * FROM drafts WHERE id = $1 FOR UPDATE', [
      params.draftId,
    ]);
    if (draftResult.rows.length === 0) {
      throw new ConflictException('Draft not found');
    }
    const currentDraft = draftFromDatabase(draftResult.rows[0]);

    // Validate draft is in correct state
    if (currentDraft.status !== 'in_progress') {
      throw new ConflictException('Draft is not in progress');
    }

    // Validate draft type
    if (currentDraft.draftType !== 'matchups') {
      throw new ConflictException('Draft is not a matchups draft');
    }

    // Critical: Validate expected pick number matches current state
    if (currentDraft.currentPick !== params.expectedPickNumber) {
      throw new ConflictException(
        `Pick already made. Expected pick ${params.expectedPickNumber}, but draft is at pick ${currentDraft.currentPick}`
      );
    }

    // Check idempotency - return existing result if found
    if (params.idempotencyKey) {
      const existing = await client.query(
        `SELECT id, pick_metadata, picked_at FROM draft_picks
         WHERE draft_id = $1 AND roster_id = $2 AND idempotency_key = $3`,
        [params.draftId, params.rosterId, params.idempotencyKey]
      );
      if (existing.rows.length > 0) {
        const existingPick = existing.rows[0];
        const metadata = existingPick.pick_metadata as MatchupPickMetadata;

        // Find reciprocal pick
        const reciprocalResult = await client.query(
          `SELECT id FROM draft_picks
           WHERE draft_id = $1 AND roster_id = $2 AND pick_metadata->>'week' = $3 AND pick_metadata->>'opponentRosterId' = $4`,
          [params.draftId, metadata.opponentRosterId, metadata.week.toString(), params.rosterId.toString()]
        );

        const updatedDraft = draftFromDatabase(draftResult.rows[0]);
        return {
          result: {
            pickId: existingPick.id,
            reciprocalPickId: reciprocalResult.rows[0]?.id || existingPick.id,
            week: metadata.week,
            pickedAt: existingPick.picked_at,
          },
          draft: updatedDraft,
        };
      }
    }

    // Validate week is not already filled for either team
    const existingMatchups = await client.query(
      `SELECT roster_id, pick_metadata FROM draft_picks
       WHERE draft_id = $1 AND pick_metadata IS NOT NULL
       AND (
         (roster_id = $2 AND pick_metadata->>'week' = $3) OR
         (roster_id = $4 AND pick_metadata->>'week' = $3)
       )`,
      [params.draftId, params.rosterId, params.week.toString(), params.opponentRosterId]
    );

    if (existingMatchups.rows.length > 0) {
      throw new ValidationException(`Week ${params.week} is already filled for one or both teams`);
    }

    // Create metadata for both picks
    const pickerMetadata: MatchupPickMetadata = {
      week: params.week,
      opponentRosterId: params.opponentRosterId,
    };

    const opponentMetadata: MatchupPickMetadata = {
      week: params.week,
      opponentRosterId: params.rosterId,
    };

    // Insert pick for the current picker
    const pickerPickResult = await client.query(
      `INSERT INTO draft_picks (draft_id, pick_number, round, pick_in_round, roster_id, player_id, pick_metadata, is_auto_pick, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, NULL, $6, $7, $8)
       RETURNING id, picked_at`,
      [
        params.draftId,
        params.expectedPickNumber,
        params.round,
        params.pickInRound,
        params.rosterId,
        JSON.stringify(pickerMetadata),
        params.isAutoPick || false,
        params.idempotencyKey || null,
      ]
    );

    const pickId = pickerPickResult.rows[0].id;
    const pickedAt = pickerPickResult.rows[0].picked_at;

    // Insert reciprocal pick for the opponent (with a synthetic pick_number)
    // Reciprocal picks use negative pick numbers to avoid conflicts
    const reciprocalPickNumber = -(params.expectedPickNumber);
    const reciprocalPickResult = await client.query(
      `INSERT INTO draft_picks (draft_id, pick_number, round, pick_in_round, roster_id, player_id, pick_metadata, is_auto_pick)
       VALUES ($1, $2, $3, $4, $5, NULL, $6, false)
       RETURNING id`,
      [
        params.draftId,
        reciprocalPickNumber,
        params.round,
        params.pickInRound,
        params.opponentRosterId,
        JSON.stringify(opponentMetadata),
      ]
    );

    const reciprocalPickId = reciprocalPickResult.rows[0].id;

    // Update draft state to next pick
    const updates: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (params.nextPickState.currentPick !== null) {
      updates.push(`current_pick = $${paramIndex++}`);
      values.push(params.nextPickState.currentPick);
    }

    if (params.nextPickState.currentRound !== null) {
      updates.push(`current_round = $${paramIndex++}`);
      values.push(params.nextPickState.currentRound);
    }

    updates.push(`current_roster_id = $${paramIndex++}`);
    values.push(params.nextPickState.currentRosterId);

    updates.push(`pick_deadline = $${paramIndex++}`);
    values.push(params.nextPickState.pickDeadline);

    if (params.nextPickState.status === 'completed') {
      updates.push(`status = $${paramIndex++}`);
      values.push('completed');

      updates.push(`completed_at = $${paramIndex++}`);
      values.push(params.nextPickState.completedAt || new Date());
    }

    updates.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(params.draftId);

    await client.query(
      `UPDATE drafts SET ${updates.join(', ')} WHERE id = $${paramIndex}`,
      values
    );

    // Read updated draft
    const updatedDraftResult = await client.query('SELECT * FROM drafts WHERE id = $1', [
      params.draftId,
    ]);
    const updatedDraft = draftFromDatabase(updatedDraftResult.rows[0]);

    logger.info(
      `Matchup pick made in draft ${params.draftId}: Week ${params.week}, Team ${params.rosterId} vs Team ${params.opponentRosterId}`
    );

    return {
      result: {
        pickId,
        reciprocalPickId,
        week: params.week,
        pickedAt,
      },
      draft: updatedDraft,
    };
  }

  /**
   * Get all matchup picks for a draft
   */
  async getMatchupPicks(draftId: number, client?: PoolClient): Promise<Array<{
    rosterId: number;
    week: number;
    opponentRosterId: number;
    pickNumber: number;
    pickedAt: Date;
  }>> {
    const db = client || this.db;
    const result = await db.query(
      `SELECT roster_id, pick_number, pick_metadata, picked_at
       FROM draft_picks
       WHERE draft_id = $1 AND pick_metadata IS NOT NULL AND pick_number > 0
       ORDER BY pick_number`,
      [draftId]
    );

    return result.rows.map(row => {
      const metadata = row.pick_metadata as MatchupPickMetadata;
      return {
        rosterId: row.roster_id,
        week: metadata.week,
        opponentRosterId: metadata.opponentRosterId,
        pickNumber: row.pick_number,
        pickedAt: row.picked_at,
      };
    });
  }

  /**
   * Get matchups for a specific team in the draft
   */
  async getRosterMatchups(draftId: number, rosterId: number, client?: PoolClient): Promise<Array<{
    week: number;
    opponentRosterId: number;
  }>> {
    const db = client || this.db;
    const result = await db.query(
      `SELECT pick_metadata FROM draft_picks
       WHERE draft_id = $1 AND roster_id = $2 AND pick_metadata IS NOT NULL
       ORDER BY (pick_metadata->>'week')::int`,
      [draftId, rosterId]
    );

    return result.rows.map(row => {
      const metadata = row.pick_metadata as MatchupPickMetadata;
      return {
        week: metadata.week,
        opponentRosterId: metadata.opponentRosterId,
      };
    });
  }
}
