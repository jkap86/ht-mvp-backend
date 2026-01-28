import { Pool, PoolClient } from 'pg';
import {
  DraftPickAsset,
  DraftPickAssetWithDetails,
  draftPickAssetFromDatabase,
} from './draft-pick-asset.model';

export class DraftPickAssetRepository {
  constructor(private readonly db: Pool) {}

  /**
   * Find a single pick asset by ID
   */
  async findById(id: number): Promise<DraftPickAsset | null> {
    const result = await this.db.query(
      'SELECT * FROM draft_pick_assets WHERE id = $1',
      [id]
    );
    return result.rows.length > 0 ? draftPickAssetFromDatabase(result.rows[0]) : null;
  }

  /**
   * Find pick asset by ID with full details (team names, usernames)
   */
  async findByIdWithDetails(id: number): Promise<DraftPickAssetWithDetails | null> {
    const result = await this.db.query(
      `SELECT
        dpa.*,
        orig_u.username as original_username,
        owner_u.username as current_owner_username,
        COALESCE(orig_r.settings->>'teamName', orig_u.username) as original_team_name,
        COALESCE(owner_r.settings->>'teamName', owner_u.username) as current_owner_team_name
       FROM draft_pick_assets dpa
       JOIN rosters orig_r ON dpa.original_roster_id = orig_r.id
       JOIN users orig_u ON orig_r.user_id = orig_u.id
       JOIN rosters owner_r ON dpa.current_owner_roster_id = owner_r.id
       JOIN users owner_u ON owner_r.user_id = owner_u.id
       WHERE dpa.id = $1`,
      [id]
    );

    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    return {
      ...draftPickAssetFromDatabase(row),
      originalTeamName: row.original_team_name,
      originalUsername: row.original_username,
      currentOwnerTeamName: row.current_owner_team_name,
      currentOwnerUsername: row.current_owner_username,
    };
  }

  /**
   * Find all pick assets for a league and season
   */
  async findByLeagueAndSeason(
    leagueId: number,
    season: number
  ): Promise<DraftPickAssetWithDetails[]> {
    const result = await this.db.query(
      `SELECT
        dpa.*,
        orig_u.username as original_username,
        owner_u.username as current_owner_username,
        COALESCE(orig_r.settings->>'teamName', orig_u.username) as original_team_name,
        COALESCE(owner_r.settings->>'teamName', owner_u.username) as current_owner_team_name
       FROM draft_pick_assets dpa
       JOIN rosters orig_r ON dpa.original_roster_id = orig_r.id
       JOIN users orig_u ON orig_r.user_id = orig_u.id
       JOIN rosters owner_r ON dpa.current_owner_roster_id = owner_r.id
       JOIN users owner_u ON owner_r.user_id = owner_u.id
       WHERE dpa.league_id = $1 AND dpa.season = $2
       ORDER BY dpa.round, dpa.original_pick_position`,
      [leagueId, season]
    );

    return result.rows.map((row) => ({
      ...draftPickAssetFromDatabase(row),
      originalTeamName: row.original_team_name,
      originalUsername: row.original_username,
      currentOwnerTeamName: row.current_owner_team_name,
      currentOwnerUsername: row.current_owner_username,
    }));
  }

  /**
   * Find all pick assets for a specific draft
   */
  async findByDraftId(draftId: number): Promise<DraftPickAssetWithDetails[]> {
    const result = await this.db.query(
      `SELECT
        dpa.*,
        orig_u.username as original_username,
        owner_u.username as current_owner_username,
        COALESCE(orig_r.settings->>'teamName', orig_u.username) as original_team_name,
        COALESCE(owner_r.settings->>'teamName', owner_u.username) as current_owner_team_name
       FROM draft_pick_assets dpa
       JOIN rosters orig_r ON dpa.original_roster_id = orig_r.id
       JOIN users orig_u ON orig_r.user_id = orig_u.id
       JOIN rosters owner_r ON dpa.current_owner_roster_id = owner_r.id
       JOIN users owner_u ON owner_r.user_id = owner_u.id
       WHERE dpa.draft_id = $1
       ORDER BY dpa.round, dpa.original_pick_position`,
      [draftId]
    );

    return result.rows.map((row) => ({
      ...draftPickAssetFromDatabase(row),
      originalTeamName: row.original_team_name,
      originalUsername: row.original_username,
      currentOwnerTeamName: row.current_owner_team_name,
      currentOwnerUsername: row.current_owner_username,
    }));
  }

  /**
   * Find all pick assets owned by a specific roster
   */
  async findByOwner(
    rosterId: number,
    leagueId?: number
  ): Promise<DraftPickAssetWithDetails[]> {
    let query = `SELECT
        dpa.*,
        orig_u.username as original_username,
        owner_u.username as current_owner_username,
        COALESCE(orig_r.settings->>'teamName', orig_u.username) as original_team_name,
        COALESCE(owner_r.settings->>'teamName', owner_u.username) as current_owner_team_name
       FROM draft_pick_assets dpa
       JOIN rosters orig_r ON dpa.original_roster_id = orig_r.id
       JOIN users orig_u ON orig_r.user_id = orig_u.id
       JOIN rosters owner_r ON dpa.current_owner_roster_id = owner_r.id
       JOIN users owner_u ON owner_r.user_id = owner_u.id
       WHERE dpa.current_owner_roster_id = $1`;

    const params: (number)[] = [rosterId];

    if (leagueId !== undefined) {
      params.push(leagueId);
      query += ` AND dpa.league_id = $${params.length}`;
    }

    query += ` ORDER BY dpa.season, dpa.round, dpa.original_pick_position`;

    const result = await this.db.query(query, params);

    return result.rows.map((row) => ({
      ...draftPickAssetFromDatabase(row),
      originalTeamName: row.original_team_name,
      originalUsername: row.original_username,
      currentOwnerTeamName: row.current_owner_team_name,
      currentOwnerUsername: row.current_owner_username,
    }));
  }

  /**
   * Find pick asset by round and original roster
   * Used during draft to determine who owns a specific pick
   */
  async findByRoundAndOriginalRoster(
    draftId: number,
    round: number,
    originalRosterId: number
  ): Promise<DraftPickAsset | null> {
    const result = await this.db.query(
      `SELECT * FROM draft_pick_assets
       WHERE draft_id = $1 AND round = $2 AND original_roster_id = $3`,
      [draftId, round, originalRosterId]
    );
    return result.rows.length > 0 ? draftPickAssetFromDatabase(result.rows[0]) : null;
  }

  /**
   * Generate pick assets for a draft
   * Creates one asset per roster per round
   */
  async generatePickAssetsForDraft(
    draftId: number,
    leagueId: number,
    season: number,
    rounds: number,
    rosterIds: number[],
    client?: PoolClient
  ): Promise<DraftPickAsset[]> {
    const queryRunner = client || this.db;

    const values: any[] = [];
    const placeholders: string[] = [];
    let paramIndex = 1;

    for (const rosterId of rosterIds) {
      for (let round = 1; round <= rounds; round++) {
        placeholders.push(
          `($${paramIndex}, $${paramIndex + 1}, $${paramIndex + 2}, $${paramIndex + 3}, $${paramIndex + 4}, $${paramIndex + 5})`
        );
        values.push(leagueId, draftId, season, round, rosterId, rosterId);
        paramIndex += 6;
      }
    }

    if (placeholders.length === 0) {
      return [];
    }

    const result = await queryRunner.query(
      `INSERT INTO draft_pick_assets
        (league_id, draft_id, season, round, original_roster_id, current_owner_roster_id)
       VALUES ${placeholders.join(', ')}
       ON CONFLICT (league_id, season, round, original_roster_id) DO NOTHING
       RETURNING *`,
      values
    );

    return result.rows.map(draftPickAssetFromDatabase);
  }

  /**
   * Generate future pick assets for dynasty leagues
   * Creates picks for seasons that don't have a draft yet
   */
  async generateFuturePickAssets(
    leagueId: number,
    season: number,
    rounds: number,
    rosterIds: number[],
    client?: PoolClient
  ): Promise<DraftPickAsset[]> {
    const queryRunner = client || this.db;

    const values: any[] = [];
    const placeholders: string[] = [];
    let paramIndex = 1;

    for (const rosterId of rosterIds) {
      for (let round = 1; round <= rounds; round++) {
        // draft_id is NULL for future picks
        placeholders.push(
          `($${paramIndex}, NULL, $${paramIndex + 1}, $${paramIndex + 2}, $${paramIndex + 3}, $${paramIndex + 4})`
        );
        values.push(leagueId, season, round, rosterId, rosterId);
        paramIndex += 5;
      }
    }

    if (placeholders.length === 0) {
      return [];
    }

    const result = await queryRunner.query(
      `INSERT INTO draft_pick_assets
        (league_id, draft_id, season, round, original_roster_id, current_owner_roster_id)
       VALUES ${placeholders.join(', ')}
       ON CONFLICT (league_id, season, round, original_roster_id) DO NOTHING
       RETURNING *`,
      values
    );

    return result.rows.map(draftPickAssetFromDatabase);
  }

  /**
   * Link future pick assets to a newly created draft
   */
  async linkAssetsToDraft(
    leagueId: number,
    season: number,
    draftId: number,
    client?: PoolClient
  ): Promise<void> {
    const queryRunner = client || this.db;

    await queryRunner.query(
      `UPDATE draft_pick_assets
       SET draft_id = $1, updated_at = CURRENT_TIMESTAMP
       WHERE league_id = $2 AND season = $3 AND draft_id IS NULL`,
      [draftId, leagueId, season]
    );
  }

  /**
   * Update pick positions based on draft order
   * Called when draft order is confirmed or changed
   */
  async updatePickPositions(draftId: number, client?: PoolClient): Promise<void> {
    const queryRunner = client || this.db;

    await queryRunner.query(
      `UPDATE draft_pick_assets dpa
       SET original_pick_position = dord.draft_position,
           updated_at = CURRENT_TIMESTAMP
       FROM draft_order dord
       WHERE dpa.draft_id = $1
         AND dpa.original_roster_id = dord.roster_id
         AND dord.draft_id = $1`,
      [draftId]
    );
  }

  /**
   * Transfer ownership of a pick asset (used when trade completes)
   */
  async transferOwnership(
    assetId: number,
    newOwnerRosterId: number,
    client?: PoolClient
  ): Promise<DraftPickAsset> {
    const queryRunner = client || this.db;

    const result = await queryRunner.query(
      `UPDATE draft_pick_assets
       SET current_owner_roster_id = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2
       RETURNING *`,
      [newOwnerRosterId, assetId]
    );

    if (result.rows.length === 0) {
      throw new Error('Pick asset not found');
    }

    return draftPickAssetFromDatabase(result.rows[0]);
  }

  /**
   * Check if a pick asset is involved in any pending trades
   */
  async isInPendingTrade(assetId: number): Promise<boolean> {
    const result = await this.db.query(
      `SELECT EXISTS(
        SELECT 1 FROM trade_items ti
        JOIN trades t ON ti.trade_id = t.id
        WHERE ti.draft_pick_asset_id = $1
          AND t.status IN ('pending', 'countered', 'accepted', 'in_review')
      )`,
      [assetId]
    );
    return result.rows[0].exists;
  }

  /**
   * Check if a pick has already been used (draft pick made with it)
   */
  async isPickUsed(assetId: number): Promise<boolean> {
    const result = await this.db.query(
      `SELECT EXISTS(
        SELECT 1 FROM draft_picks
        WHERE draft_pick_asset_id = $1
      )`,
      [assetId]
    );
    return result.rows[0].exists;
  }

  /**
   * Check if the pick's round has already passed in the draft
   */
  async isRoundPassed(assetId: number): Promise<boolean> {
    const result = await this.db.query(
      `SELECT
        dpa.round,
        d.current_round,
        d.status
       FROM draft_pick_assets dpa
       JOIN drafts d ON dpa.draft_id = d.id
       WHERE dpa.id = $1`,
      [assetId]
    );

    if (result.rows.length === 0) {
      return false; // No draft linked, pick not used yet
    }

    const { round, current_round, status } = result.rows[0];

    // If draft is completed, all rounds have passed
    if (status === 'completed') {
      return true;
    }

    // If draft is in progress, check if we're past this round
    if (status === 'in_progress' && current_round > round) {
      return true;
    }

    return false;
  }

  /**
   * Get all available pick assets for trading
   * Returns picks that are owned by the roster and not in pending trades
   */
  async findAvailableForTrade(
    rosterId: number,
    leagueId: number
  ): Promise<DraftPickAssetWithDetails[]> {
    const result = await this.db.query(
      `SELECT
        dpa.*,
        orig_u.username as original_username,
        owner_u.username as current_owner_username,
        COALESCE(orig_r.settings->>'teamName', orig_u.username) as original_team_name,
        COALESCE(owner_r.settings->>'teamName', owner_u.username) as current_owner_team_name
       FROM draft_pick_assets dpa
       JOIN rosters orig_r ON dpa.original_roster_id = orig_r.id
       JOIN users orig_u ON orig_r.user_id = orig_u.id
       JOIN rosters owner_r ON dpa.current_owner_roster_id = owner_r.id
       JOIN users owner_u ON owner_r.user_id = owner_u.id
       LEFT JOIN drafts d ON dpa.draft_id = d.id
       WHERE dpa.current_owner_roster_id = $1
         AND dpa.league_id = $2
         -- Exclude picks already used
         AND NOT EXISTS (
           SELECT 1 FROM draft_picks dp WHERE dp.draft_pick_asset_id = dpa.id
         )
         -- Exclude picks in pending trades
         AND NOT EXISTS (
           SELECT 1 FROM trade_items ti
           JOIN trades t ON ti.trade_id = t.id
           WHERE ti.draft_pick_asset_id = dpa.id
             AND t.status IN ('pending', 'countered', 'accepted', 'in_review')
         )
         -- Exclude picks for rounds that have passed
         AND (
           d.id IS NULL  -- Future pick with no draft
           OR d.status IN ('not_started', 'paused')
           OR (d.status = 'in_progress' AND dpa.round >= d.current_round)
         )
       ORDER BY dpa.season, dpa.round, dpa.original_pick_position`,
      [rosterId, leagueId]
    );

    return result.rows.map((row) => ({
      ...draftPickAssetFromDatabase(row),
      originalTeamName: row.original_team_name,
      originalUsername: row.original_username,
      currentOwnerTeamName: row.current_owner_team_name,
      currentOwnerUsername: row.current_owner_username,
    }));
  }

  /**
   * Delete all pick assets for a draft (used when draft is deleted)
   */
  async deleteByDraftId(draftId: number, client?: PoolClient): Promise<void> {
    const queryRunner = client || this.db;
    await queryRunner.query(
      'DELETE FROM draft_pick_assets WHERE draft_id = $1',
      [draftId]
    );
  }

  /**
   * Get distinct seasons that have pick assets for a league
   */
  async getSeasons(leagueId: number): Promise<number[]> {
    const result = await this.db.query(
      `SELECT DISTINCT season FROM draft_pick_assets
       WHERE league_id = $1
       ORDER BY season`,
      [leagueId]
    );
    return result.rows.map((row) => row.season);
  }
}
