/**
 * Draft Pick Repository
 *
 * Handles draft pick operations including:
 * - Creating and querying picks
 * - Atomic pick + state advance transactions
 * - Undo operations
 */

import type { Pool, PoolClient } from 'pg';
import type { Draft, DraftPick } from '../drafts.model';
import { draftFromDatabase } from '../drafts.model';
import { ConflictException } from '../../../utils/exceptions';
import { getLockId, LockDomain } from '../../../shared/locks';
import { runWithLock } from '../../../shared/transaction-runner';
import { DraftPickMapper } from '../../../shared/mappers';

export class DraftPickRepository {
  constructor(private readonly db: Pool) {}

  /**
   * Get all picks for a draft with player and user info.
   */
  async getDraftPicks(draftId: number, limit?: number, offset?: number): Promise<DraftPick[]> {
    let query = `SELECT dp.*, p.full_name as player_name, p.position as player_position, p.team as player_team, u.username
       FROM draft_picks dp
       LEFT JOIN players p ON dp.player_id = p.id
       LEFT JOIN rosters r ON dp.roster_id = r.id
       LEFT JOIN users u ON r.user_id = u.id
       WHERE dp.draft_id = $1
       ORDER BY dp.pick_number`;

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
    return DraftPickMapper.fromRows(result.rows);
  }

  /**
   * Get all picks for a draft using an existing client (for use within transactions).
   */
  async getDraftPicksWithClient(client: PoolClient, draftId: number): Promise<DraftPick[]> {
    const query = `SELECT dp.*, p.full_name as player_name, p.position as player_position, p.team as player_team, u.username
       FROM draft_picks dp
       LEFT JOIN players p ON dp.player_id = p.id
       LEFT JOIN rosters r ON dp.roster_id = r.id
       LEFT JOIN users u ON r.user_id = u.id
       WHERE dp.draft_id = $1
       ORDER BY dp.pick_number`;

    const result = await client.query(query, [draftId]);
    return DraftPickMapper.fromRows(result.rows);
  }

  /**
   * Create a simple draft pick (without transaction or cleanup).
   */
  async createDraftPick(
    draftId: number,
    pickNumber: number,
    round: number,
    pickInRound: number,
    rosterId: number,
    playerId: number
  ): Promise<DraftPick> {
    const result = await this.db.query(
      `INSERT INTO draft_picks (draft_id, pick_number, round, pick_in_round, roster_id, player_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [draftId, pickNumber, round, pickInRound, rosterId, playerId]
    );
    return DraftPickMapper.fromRow(result.rows[0]);
  }

  /**
   * Creates a draft pick and removes the player from all queues atomically.
   * Uses pg_advisory_xact_lock to prevent race conditions between concurrent picks.
   * Supports idempotency keys for safe retries.
   */
  async createDraftPickWithCleanup(
    draftId: number,
    pickNumber: number,
    round: number,
    pickInRound: number,
    rosterId: number,
    playerId: number,
    idempotencyKey?: string
  ): Promise<DraftPick> {
    return runWithLock(this.db, LockDomain.DRAFT, draftId, async (client) => {
      // Check idempotency - return existing pick if found
      if (idempotencyKey) {
        const existing = await client.query(
          `SELECT * FROM draft_picks
           WHERE draft_id = $1 AND roster_id = $2 AND idempotency_key = $3`,
          [draftId, rosterId, idempotencyKey]
        );
        if (existing.rows.length > 0) {
          return DraftPickMapper.fromRow(existing.rows[0]);
        }
      }

      // Re-check player not drafted (inside lock to prevent race condition)
      const alreadyDrafted = await client.query(
        'SELECT 1 FROM draft_picks WHERE draft_id = $1 AND player_id = $2',
        [draftId, playerId]
      );
      if (alreadyDrafted.rows.length > 0) {
        throw new ConflictException('Player has already been drafted');
      }

      // Create the pick with idempotency key
      const pickResult = await client.query(
        `INSERT INTO draft_picks (draft_id, pick_number, round, pick_in_round, roster_id, player_id, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [draftId, pickNumber, round, pickInRound, rosterId, playerId, idempotencyKey || null]
      );

      // Remove player from all queues in this draft
      await client.query('DELETE FROM draft_queue WHERE draft_id = $1 AND player_id = $2', [
        draftId,
        playerId,
      ]);

      return DraftPickMapper.fromRow(pickResult.rows[0]);
    });
  }

  /**
   * Undoes the most recent draft pick atomically.
   * Uses advisory lock to prevent race conditions.
   * Returns the deleted pick with player info, or null if no picks exist.
   */
  async undoLastPick(draftId: number): Promise<DraftPick | null> {
    return runWithLock(this.db, LockDomain.DRAFT, draftId, async (client) => {
      // Get most recent pick with player info
      const lastPick = await client.query(
        `SELECT dp.*, p.full_name as player_name, p.position as player_position, p.team as player_team, u.username
         FROM draft_picks dp
         LEFT JOIN players p ON dp.player_id = p.id
         LEFT JOIN rosters r ON dp.roster_id = r.id
         LEFT JOIN users u ON r.user_id = u.id
         WHERE dp.draft_id = $1
         ORDER BY dp.pick_number DESC LIMIT 1`,
        [draftId]
      );

      if (lastPick.rows.length === 0) {
        return null;
      }

      const row = lastPick.rows[0];

      // Delete the pick
      await client.query('DELETE FROM draft_picks WHERE id = $1', [row.id]);

      return DraftPickMapper.fromRow(row);
    });
  }

  /**
   * Check if a player has been drafted in a draft.
   */
  async isPlayerDrafted(draftId: number, playerId: number): Promise<boolean> {
    const result = await this.db.query(
      'SELECT EXISTS(SELECT 1 FROM draft_picks WHERE draft_id = $1 AND player_id = $2)',
      [draftId, playerId]
    );
    return result.rows[0].exists;
  }

  /**
   * Get all drafted player IDs for a draft.
   */
  async getDraftedPlayerIds(draftId: number): Promise<Set<number>> {
    const result = await this.db.query(
      'SELECT player_id FROM draft_picks WHERE draft_id = $1 AND player_id IS NOT NULL',
      [draftId]
    );
    return new Set(result.rows.map((row) => row.player_id));
  }

  /**
   * Get all drafted player IDs for a draft using an existing client (for transactions).
   */
  async getDraftedPlayerIdsWithClient(
    client: PoolClient,
    draftId: number
  ): Promise<Set<number>> {
    const result = await client.query(
      'SELECT player_id FROM draft_picks WHERE draft_id = $1 AND player_id IS NOT NULL',
      [draftId]
    );
    return new Set(result.rows.map((row) => row.player_id));
  }

  /**
   * Mark a pick as an auto-pick.
   */
  async markPickAsAutoPick(pickId: number): Promise<void> {
    await this.db.query('UPDATE draft_picks SET is_auto_pick = true WHERE id = $1', [pickId]);
  }

  /**
   * Check if a pick already exists for the given draft and pick number.
   */
  async pickExists(draftId: number, pickNumber: number): Promise<boolean> {
    const result = await this.db.query(
      'SELECT 1 FROM draft_picks WHERE draft_id = $1 AND pick_number = $2',
      [draftId, pickNumber]
    );
    return result.rows.length > 0;
  }

  /**
   * Check if a pick already exists using an existing client (for use within transactions).
   */
  async pickExistsWithClient(
    client: PoolClient,
    draftId: number,
    pickNumber: number
  ): Promise<boolean> {
    const result = await client.query(
      'SELECT 1 FROM draft_picks WHERE draft_id = $1 AND pick_number = $2',
      [draftId, pickNumber]
    );
    return result.rows.length > 0;
  }

  /**
   * Atomically make a pick and advance the draft state in a single transaction.
   * This prevents race conditions where pick is inserted but draft state doesn't advance.
   */
  async makePickAndAdvanceTx(params: {
    draftId: number;
    expectedPickNumber: number;
    round: number;
    pickInRound: number;
    rosterId: number;
    playerId: number;
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
  }): Promise<{ pick: DraftPick; draft: Draft }> {
    return runWithLock(this.db, LockDomain.DRAFT, params.draftId, (client) =>
      this.makePickAndAdvanceTxWithClient(client, params)
    );
  }

  /**
   * Make a pick using an existing client that already holds the draft lock.
   * Use this when the caller has already acquired the lock and read fresh data.
   */
  async makePickAndAdvanceTxWithClient(
    client: PoolClient,
    params: {
      draftId: number;
      expectedPickNumber: number;
      round: number;
      pickInRound: number;
      rosterId: number;
      playerId: number;
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
  ): Promise<{ pick: DraftPick; draft: Draft }> {
    return (async () => {
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

      // Check idempotency FIRST - return existing pick if found
      if (params.idempotencyKey) {
        const existing = await client.query(
          `SELECT * FROM draft_picks
           WHERE draft_id = $1 AND roster_id = $2 AND idempotency_key = $3`,
          [params.draftId, params.rosterId, params.idempotencyKey]
        );
        if (existing.rows.length > 0) {
          return {
            pick: DraftPickMapper.fromRow(existing.rows[0]),
            draft: currentDraft,
          };
        }
      }

      // Critical: Validate expected pick number matches current state
      if (currentDraft.currentPick !== params.expectedPickNumber) {
        throw new ConflictException(
          `Pick already made. Expected pick ${params.expectedPickNumber}, but draft is at pick ${currentDraft.currentPick}`
        );
      }

      // Validate it's the correct roster's turn
      if (currentDraft.currentRosterId !== params.rosterId) {
        throw new ConflictException('It is not your turn to pick');
      }

      // Validate player not already drafted
      const alreadyDrafted = await client.query(
        'SELECT 1 FROM draft_picks WHERE draft_id = $1 AND player_id = $2',
        [params.draftId, params.playerId]
      );
      if (alreadyDrafted.rows.length > 0) {
        throw new ConflictException('Player has already been drafted');
      }

      // Insert the pick
      const pickResult = await client.query(
        `INSERT INTO draft_picks (draft_id, pick_number, round, pick_in_round, roster_id, player_id, idempotency_key, is_auto_pick)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [
          params.draftId,
          params.expectedPickNumber,
          params.round,
          params.pickInRound,
          params.rosterId,
          params.playerId,
          params.idempotencyKey || null,
          params.isAutoPick ?? false,
        ]
      );

      // Remove player from all queues in this draft
      await client.query('DELETE FROM draft_queue WHERE draft_id = $1 AND player_id = $2', [
        params.draftId,
        params.playerId,
      ]);

      // Update draft state atomically
      const updatedDraft = await this.updateDraftStateWithClient(
        client,
        params.draftId,
        params.nextPickState
      );

      return {
        pick: DraftPickMapper.fromRow(pickResult.rows[0]),
        draft: updatedDraft,
      };
    })();
  }

  /**
   * Atomically make a pick asset selection and advance the draft state.
   */
  async makePickAssetSelectionTx(params: {
    draftId: number;
    expectedPickNumber: number;
    draftPickAssetId: number;
    rosterId: number;
    nextPickState: {
      currentPick: number | null;
      currentRound: number | null;
      currentRosterId: number | null;
      pickDeadline: Date | null;
      status?: 'in_progress' | 'completed';
      completedAt?: Date | null;
    };
    idempotencyKey?: string;
  }): Promise<{
    selectionId: number;
    selectedAt: Date;
    draft: Draft;
  }> {
    return runWithLock(this.db, LockDomain.DRAFT, params.draftId, (client) =>
      this.makePickAssetSelectionTxWithClient(client, params)
    );
  }

  /**
   * Make a pick asset selection using an existing client that already holds the draft lock.
   * Use this when the caller has already acquired the lock and read fresh data.
   */
  async makePickAssetSelectionTxWithClient(
    client: PoolClient,
    params: {
      draftId: number;
      expectedPickNumber: number;
      draftPickAssetId: number;
      rosterId: number;
      nextPickState: {
        currentPick: number | null;
        currentRound: number | null;
        currentRosterId: number | null;
        pickDeadline: Date | null;
        status?: 'in_progress' | 'completed';
        completedAt?: Date | null;
      };
      idempotencyKey?: string;
    }
  ): Promise<{
    selectionId: number;
    selectedAt: Date;
    draft: Draft;
  }> {
    return (async () => {
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

      // Check idempotency FIRST - return existing selection if found
      if (params.idempotencyKey) {
        const existing = await client.query(
          `SELECT * FROM vet_draft_pick_selections
           WHERE draft_id = $1 AND roster_id = $2 AND pick_number = $3`,
          [params.draftId, params.rosterId, params.expectedPickNumber]
        );
        if (existing.rows.length > 0) {
          const row = existing.rows[0];
          return {
            selectionId: row.id,
            selectedAt: row.selected_at,
            draft: currentDraft,
          };
        }
      }

      // Critical: Validate expected pick number matches current state
      if (currentDraft.currentPick !== params.expectedPickNumber) {
        throw new ConflictException(
          `Pick already made. Expected pick ${params.expectedPickNumber}, but draft is at pick ${currentDraft.currentPick}`
        );
      }

      // Validate it's the correct roster's turn
      if (currentDraft.currentRosterId !== params.rosterId) {
        throw new ConflictException('It is not your turn to pick');
      }

      // Validate pick asset not already selected in this draft
      const alreadySelected = await client.query(
        `SELECT 1 FROM vet_draft_pick_selections WHERE draft_id = $1 AND draft_pick_asset_id = $2`,
        [params.draftId, params.draftPickAssetId]
      );
      if (alreadySelected.rows.length > 0) {
        throw new ConflictException('This pick asset has already been drafted');
      }

      // Defensive validation: verify pick asset belongs to this draft's league
      const assetCheck = await client.query(
        'SELECT league_id FROM draft_pick_assets WHERE id = $1',
        [params.draftPickAssetId]
      );
      if (assetCheck.rows.length === 0) {
        throw new ConflictException('Pick asset not found');
      }
      if (assetCheck.rows[0].league_id !== currentDraft.leagueId) {
        throw new ConflictException('Pick asset does not belong to this league');
      }

      // Insert the selection
      const selectionResult = await client.query(
        `INSERT INTO vet_draft_pick_selections (draft_id, draft_pick_asset_id, pick_number, roster_id)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [params.draftId, params.draftPickAssetId, params.expectedPickNumber, params.rosterId]
      );

      // Transfer ownership of the pick asset to the drafter
      await client.query(
        `UPDATE draft_pick_assets
         SET current_owner_roster_id = $1, updated_at = CURRENT_TIMESTAMP
         WHERE id = $2`,
        [params.rosterId, params.draftPickAssetId]
      );

      // Remove pick asset from all queues in this draft
      await client.query('DELETE FROM draft_queue WHERE draft_id = $1 AND pick_asset_id = $2', [
        params.draftId,
        params.draftPickAssetId,
      ]);

      // Update draft state atomically
      const updatedDraft = await this.updateDraftStateWithClient(
        client,
        params.draftId,
        params.nextPickState
      );

      const selectionRow = selectionResult.rows[0];
      return {
        selectionId: selectionRow.id,
        selectedAt: selectionRow.selected_at,
        draft: updatedDraft,
      };
    })();
  }

  /**
   * Atomically undo the last pick (player or pick-asset) and update draft state.
   * Checks both draft_picks and vet_draft_pick_selections to find the most recent action.
   */
  async undoLastPickTx(params: {
    draftId: number;
    prevPickState: {
      currentPick: number;
      currentRound: number;
      currentRosterId: number | null;
      pickDeadline: Date | null;
      status: 'in_progress' | 'paused';
      completedAt: null;
    };
    includeRookiePicks?: boolean;
  }): Promise<{
    undonePick: DraftPick | null;
    undoneSelection?: { id: number; draftPickAssetId: number; pickNumber: number; rosterId: number } | null;
    draft: Draft;
  }> {
    return runWithLock(this.db, LockDomain.DRAFT, params.draftId, (client) =>
      this.undoLastPickTxWithClient(client, params)
    );
  }

  /**
   * Undo the last pick using an existing client that already holds the draft lock.
   * Use this when the caller has already acquired the lock and read fresh data.
   */
  async undoLastPickTxWithClient(
    client: PoolClient,
    params: {
      draftId: number;
      prevPickState: {
        currentPick: number;
        currentRound: number;
        currentRosterId: number | null;
        pickDeadline: Date | null;
        status: 'in_progress' | 'paused';
        completedAt: null;
      };
      includeRookiePicks?: boolean;
    }
  ): Promise<{
    undonePick: DraftPick | null;
    undoneSelection?: { id: number; draftPickAssetId: number; pickNumber: number; rosterId: number } | null;
    draft: Draft;
  }> {
    return (async () => {
      // Re-read draft row FOR UPDATE
      const draftResult = await client.query('SELECT * FROM drafts WHERE id = $1 FOR UPDATE', [
        params.draftId,
      ]);
      if (draftResult.rows.length === 0) {
        throw new ConflictException('Draft not found');
      }

      // Get most recent player pick
      const lastPlayerPick = await client.query(
        `SELECT dp.*, p.full_name as player_name, p.position as player_position, p.team as player_team, u.username
         FROM draft_picks dp
         LEFT JOIN players p ON dp.player_id = p.id
         LEFT JOIN rosters r ON dp.roster_id = r.id
         LEFT JOIN users u ON r.user_id = u.id
         WHERE dp.draft_id = $1
         ORDER BY dp.pick_number DESC LIMIT 1`,
        [params.draftId]
      );

      // Get most recent pick-asset selection if enabled
      let lastAssetSelection: any = null;
      if (params.includeRookiePicks) {
        const assetResult = await client.query(
          `SELECT * FROM vet_draft_pick_selections WHERE draft_id = $1 ORDER BY pick_number DESC LIMIT 1`,
          [params.draftId]
        );
        if (assetResult.rows.length > 0) {
          lastAssetSelection = assetResult.rows[0];
        }
      }

      const lastPlayerPickNumber = lastPlayerPick.rows.length > 0 ? lastPlayerPick.rows[0].pick_number : -1;
      const lastAssetPickNumber = lastAssetSelection ? lastAssetSelection.pick_number : -1;

      // No picks to undo
      if (lastPlayerPickNumber === -1 && lastAssetPickNumber === -1) {
        return {
          undonePick: null,
          undoneSelection: null,
          draft: draftFromDatabase(draftResult.rows[0]),
        };
      }

      let undonePick: DraftPick | null = null;
      let undoneSelection: { id: number; draftPickAssetId: number; pickNumber: number; rosterId: number } | null = null;

      // Undo whichever was most recent (higher pick number)
      if (lastPlayerPickNumber >= lastAssetPickNumber) {
        // Undo player pick
        const row = lastPlayerPick.rows[0];
        await client.query('DELETE FROM draft_picks WHERE id = $1', [row.id]);
        undonePick = DraftPickMapper.fromRow(row);
      } else {
        // Undo pick-asset selection
        await client.query('DELETE FROM vet_draft_pick_selections WHERE id = $1', [lastAssetSelection.id]);

        // Revert pick asset ownership back to original roster
        await client.query(
          `UPDATE draft_pick_assets
           SET current_owner_roster_id = original_roster_id, updated_at = CURRENT_TIMESTAMP
           WHERE id = $1`,
          [lastAssetSelection.draft_pick_asset_id]
        );

        undoneSelection = {
          id: lastAssetSelection.id,
          draftPickAssetId: lastAssetSelection.draft_pick_asset_id,
          pickNumber: lastAssetSelection.pick_number,
          rosterId: lastAssetSelection.roster_id,
        };
      }

      // Update draft state atomically
      const updatedDraftResult = await client.query(
        `UPDATE drafts
         SET current_pick = $1, current_round = $2, current_roster_id = $3,
             pick_deadline = $4, status = $5, completed_at = $6, updated_at = CURRENT_TIMESTAMP
         WHERE id = $7
         RETURNING *`,
        [
          params.prevPickState.currentPick,
          params.prevPickState.currentRound,
          params.prevPickState.currentRosterId,
          params.prevPickState.pickDeadline,
          params.prevPickState.status,
          params.prevPickState.completedAt,
          params.draftId,
        ]
      );

      return {
        undonePick,
        undoneSelection,
        draft: draftFromDatabase(updatedDraftResult.rows[0]),
      };
    })();
  }

  /**
   * Helper to update draft state within an existing transaction.
   */
  private async updateDraftStateWithClient(
    client: PoolClient,
    draftId: number,
    state: {
      currentPick?: number | null;
      currentRound?: number | null;
      currentRosterId?: number | null;
      pickDeadline?: Date | null;
      status?: 'in_progress' | 'completed';
      completedAt?: Date | null;
    }
  ): Promise<Draft> {
    const updateClauses: string[] = [];
    const updateValues: any[] = [];
    let paramIndex = 1;

    if (state.status !== undefined) {
      updateClauses.push(`status = $${paramIndex++}`);
      updateValues.push(state.status);
    }
    if (state.currentPick !== undefined) {
      updateClauses.push(`current_pick = $${paramIndex++}`);
      updateValues.push(state.currentPick);
    }
    if (state.currentRound !== undefined) {
      updateClauses.push(`current_round = $${paramIndex++}`);
      updateValues.push(state.currentRound);
    }
    if (state.currentRosterId !== undefined) {
      updateClauses.push(`current_roster_id = $${paramIndex++}`);
      updateValues.push(state.currentRosterId);
    }
    if (state.pickDeadline !== undefined) {
      updateClauses.push(`pick_deadline = $${paramIndex++}`);
      updateValues.push(state.pickDeadline);
    }
    if (state.completedAt !== undefined) {
      updateClauses.push(`completed_at = $${paramIndex++}`);
      updateValues.push(state.completedAt);
    }

    updateValues.push(draftId);
    const updatedDraftResult = await client.query(
      `UPDATE drafts SET ${updateClauses.join(', ')}, updated_at = CURRENT_TIMESTAMP
       WHERE id = $${paramIndex}
       RETURNING *`,
      updateValues
    );

    return draftFromDatabase(updatedDraftResult.rows[0]);
  }
}
