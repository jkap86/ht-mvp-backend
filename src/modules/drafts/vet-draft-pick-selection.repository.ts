import { Pool, PoolClient } from 'pg';
import { DraftPickAsset, draftPickAssetFromDatabase } from './draft-pick-asset.model';

/**
 * Represents a pick asset selection made during a vet draft
 */
export interface VetDraftPickSelection {
  id: number;
  draftId: number;
  draftPickAssetId: number;
  pickNumber: number;
  rosterId: number;
  selectedAt: Date;
}

/**
 * Extended selection with pick asset details
 */
export interface VetDraftPickSelectionWithDetails extends VetDraftPickSelection {
  pickAsset: DraftPickAsset;
  originalTeamName: string;
  currentOwnerTeamName: string;
}

function selectionFromDatabase(row: any): VetDraftPickSelection {
  return {
    id: row.id,
    draftId: row.draft_id,
    draftPickAssetId: row.draft_pick_asset_id,
    pickNumber: row.pick_number,
    rosterId: row.roster_id,
    selectedAt: row.selected_at,
  };
}

export class VetDraftPickSelectionRepository {
  constructor(private readonly db: Pool) {}

  /**
   * Record a pick asset selection made during a vet draft
   */
  async create(
    draftId: number,
    draftPickAssetId: number,
    pickNumber: number,
    rosterId: number,
    client?: PoolClient
  ): Promise<VetDraftPickSelection> {
    const queryRunner = client || this.db;
    const result = await queryRunner.query(
      `INSERT INTO vet_draft_pick_selections
        (draft_id, draft_pick_asset_id, pick_number, roster_id)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [draftId, draftPickAssetId, pickNumber, rosterId]
    );
    return selectionFromDatabase(result.rows[0]);
  }

  /**
   * Get all pick asset selections for a vet draft
   */
  async findByDraftId(draftId: number): Promise<VetDraftPickSelectionWithDetails[]> {
    const result = await this.db.query(
      `SELECT
        vdps.*,
        dpa.*,
        orig_u.username as original_username,
        owner_u.username as current_owner_username,
        COALESCE(orig_r.settings->>'teamName', orig_u.username) as original_team_name,
        COALESCE(owner_r.settings->>'teamName', owner_u.username) as current_owner_team_name
       FROM vet_draft_pick_selections vdps
       JOIN draft_pick_assets dpa ON vdps.draft_pick_asset_id = dpa.id
       JOIN rosters orig_r ON dpa.original_roster_id = orig_r.id
       JOIN users orig_u ON orig_r.user_id = orig_u.id
       JOIN rosters owner_r ON dpa.current_owner_roster_id = owner_r.id
       JOIN users owner_u ON owner_r.user_id = owner_u.id
       WHERE vdps.draft_id = $1
       ORDER BY vdps.pick_number`,
      [draftId]
    );

    return result.rows.map((row) => ({
      ...selectionFromDatabase(row),
      pickAsset: draftPickAssetFromDatabase(row),
      originalTeamName: row.original_team_name,
      currentOwnerTeamName: row.current_owner_team_name,
    }));
  }

  /**
   * Check if a pick asset has already been selected in a vet draft
   */
  async isAssetSelected(
    draftId: number,
    draftPickAssetId: number,
    client?: PoolClient
  ): Promise<boolean> {
    const queryRunner = client || this.db;
    const result = await queryRunner.query(
      `SELECT EXISTS(
        SELECT 1 FROM vet_draft_pick_selections
        WHERE draft_id = $1 AND draft_pick_asset_id = $2
      )`,
      [draftId, draftPickAssetId]
    );
    return result.rows[0].exists;
  }

  /**
   * Get the set of pick asset IDs that have been selected in a vet draft
   */
  async getSelectedAssetIds(draftId: number): Promise<Set<number>> {
    const result = await this.db.query(
      `SELECT draft_pick_asset_id FROM vet_draft_pick_selections WHERE draft_id = $1`,
      [draftId]
    );
    return new Set(result.rows.map((row) => row.draft_pick_asset_id));
  }

  /**
   * Get the set of pick asset IDs that have been selected in a vet draft
   * using an existing client (for transactions).
   */
  async getSelectedAssetIdsWithClient(
    client: PoolClient,
    draftId: number
  ): Promise<Set<number>> {
    const result = await client.query(
      `SELECT draft_pick_asset_id FROM vet_draft_pick_selections WHERE draft_id = $1`,
      [draftId]
    );
    return new Set(result.rows.map((row) => row.draft_pick_asset_id));
  }

  /**
   * Get selections made by a specific roster in a vet draft
   */
  async findByRoster(draftId: number, rosterId: number): Promise<VetDraftPickSelectionWithDetails[]> {
    const result = await this.db.query(
      `SELECT
        vdps.*,
        dpa.*,
        orig_u.username as original_username,
        owner_u.username as current_owner_username,
        COALESCE(orig_r.settings->>'teamName', orig_u.username) as original_team_name,
        COALESCE(owner_r.settings->>'teamName', owner_u.username) as current_owner_team_name
       FROM vet_draft_pick_selections vdps
       JOIN draft_pick_assets dpa ON vdps.draft_pick_asset_id = dpa.id
       JOIN rosters orig_r ON dpa.original_roster_id = orig_r.id
       JOIN users orig_u ON orig_r.user_id = orig_u.id
       JOIN rosters owner_r ON dpa.current_owner_roster_id = owner_r.id
       JOIN users owner_u ON owner_r.user_id = owner_u.id
       WHERE vdps.draft_id = $1 AND vdps.roster_id = $2
       ORDER BY vdps.pick_number`,
      [draftId, rosterId]
    );

    return result.rows.map((row) => ({
      ...selectionFromDatabase(row),
      pickAsset: draftPickAssetFromDatabase(row),
      originalTeamName: row.original_team_name,
      currentOwnerTeamName: row.current_owner_team_name,
    }));
  }

  /**
   * Delete all selections for a draft (used when draft is deleted)
   */
  async deleteByDraftId(draftId: number, client?: PoolClient): Promise<void> {
    const queryRunner = client || this.db;
    await queryRunner.query(
      'DELETE FROM vet_draft_pick_selections WHERE draft_id = $1',
      [draftId]
    );
  }
}
