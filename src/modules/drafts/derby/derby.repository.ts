/**
 * Derby Repository
 *
 * Handles database operations for derby draft order mode.
 * Uses the draft_state JSONB column to store derby runtime state.
 */

import type { Pool, PoolClient } from 'pg';
import type { DerbyState } from './derby.models';
import { draftFromDatabase, type Draft } from '../drafts.model';

export class DerbyRepository {
  constructor(private readonly db: Pool) {}

  /**
   * Get derby state from a draft.
   */
  async getDerbyState(draftId: number): Promise<DerbyState | null> {
    const result = await this.db.query('SELECT draft_state FROM drafts WHERE id = $1', [draftId]);
    if (result.rows.length === 0) {
      return null;
    }
    return this.parseState(result.rows[0].draft_state);
  }

  /**
   * Get derby state from a draft using an existing client (for use within transactions).
   */
  async getDerbyStateWithClient(client: PoolClient, draftId: number): Promise<DerbyState | null> {
    const result = await client.query('SELECT draft_state FROM drafts WHERE id = $1', [draftId]);
    if (result.rows.length === 0) {
      return null;
    }
    return this.parseState(result.rows[0].draft_state);
  }

  /**
   * Initialize derby state for a draft.
   * Sets up turn order and first picker.
   */
  async initializeDerbyState(
    client: PoolClient,
    draftId: number,
    state: DerbyState
  ): Promise<void> {
    await client.query(
      `UPDATE drafts
       SET phase = 'DERBY',
           status = 'in_progress',
           started_at = CURRENT_TIMESTAMP,
           draft_state = draft_state || $2::jsonb,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [draftId, JSON.stringify(this.serializeState(state))]
    );
  }

  /**
   * Update derby state for a draft.
   */
  async updateDerbyState(client: PoolClient, draftId: number, state: DerbyState): Promise<void> {
    await client.query(
      `UPDATE drafts
       SET draft_state = draft_state || $2::jsonb,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [draftId, JSON.stringify(this.serializeState(state))]
    );
  }

  /**
   * Transition from derby to live phase.
   * Updates draft_order table with the claimed slots.
   */
  async transitionToLive(
    client: PoolClient,
    draftId: number,
    claimedSlots: Record<number, number>,
    firstPickerRosterId: number,
    pickDeadline: Date
  ): Promise<void> {
    // Clear existing draft order
    await client.query('DELETE FROM draft_order WHERE draft_id = $1', [draftId]);

    // Insert new order based on claimed slots
    const entries = Object.entries(claimedSlots).map(([slot, rosterId]) => ({
      slot: parseInt(slot, 10),
      rosterId,
    }));
    entries.sort((a, b) => a.slot - b.slot);

    for (const { slot, rosterId } of entries) {
      await client.query(
        `INSERT INTO draft_order (draft_id, roster_id, draft_position)
         VALUES ($1, $2, $3)`,
        [draftId, rosterId, slot]
      );
    }

    // Update draft: phase to LIVE, set first picker
    // Clear derby-specific state from draft_state
    await client.query(
      `UPDATE drafts
       SET phase = 'LIVE',
           current_pick = 1,
           current_round = 1,
           current_roster_id = $2,
           pick_deadline = $3,
           order_confirmed = true,
           draft_state = draft_state - 'turnOrder' - 'currentTurnIndex' - 'currentPickerRosterId' - 'slotPickDeadline' - 'claimedSlots',
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [draftId, firstPickerRosterId, pickDeadline]
    );
  }

  /**
   * Find drafts in DERBY phase with expired slot pick deadline.
   */
  async findExpiredDerbyDrafts(): Promise<Draft[]> {
    const result = await this.db.query(
      `SELECT * FROM drafts
       WHERE phase = 'DERBY'
         AND status = 'in_progress'
         AND (draft_state->>'slotPickDeadline')::timestamptz < NOW()`
    );
    return result.rows.map(draftFromDatabase);
  }

  /**
   * Parse derby state from JSON.
   */
  private parseState(draftState: Record<string, any> | null): DerbyState | null {
    if (!draftState || !draftState.turnOrder) {
      return null;
    }
    return {
      turnOrder: draftState.turnOrder,
      currentTurnIndex: draftState.currentTurnIndex ?? 0,
      currentPickerRosterId: draftState.currentPickerRosterId,
      slotPickDeadline: draftState.slotPickDeadline
        ? new Date(draftState.slotPickDeadline)
        : null,
      claimedSlots: draftState.claimedSlots ?? {},
    };
  }

  /**
   * Serialize derby state to JSON.
   */
  private serializeState(state: DerbyState): Record<string, any> {
    return {
      turnOrder: state.turnOrder,
      currentTurnIndex: state.currentTurnIndex,
      currentPickerRosterId: state.currentPickerRosterId,
      slotPickDeadline: state.slotPickDeadline?.toISOString() ?? null,
      claimedSlots: state.claimedSlots,
    };
  }
}
