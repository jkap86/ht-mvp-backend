/**
 * KeeperSelection Model
 * Tracks which players/assets a roster is keeping from previous season
 */

export class KeeperSelection {
  constructor(
    public readonly id: number,
    public readonly leagueSeasonId: number,
    public readonly rosterId: number,
    public readonly playerId: number | null,
    public readonly draftPickAssetId: number | null,
    public readonly keeperRoundCost: number | null,
    public readonly selectedAt: Date
  ) {
    // Validate XOR: exactly one of playerId or draftPickAssetId must be set
    if ((playerId === null && draftPickAssetId === null) ||
        (playerId !== null && draftPickAssetId !== null)) {
      throw new Error('KeeperSelection must have either playerId OR draftPickAssetId, not both or neither');
    }
  }

  static fromDatabase(row: any): KeeperSelection {
    return new KeeperSelection(
      row.id,
      row.league_season_id,
      row.roster_id,
      row.player_id,
      row.draft_pick_asset_id,
      row.keeper_round_cost,
      new Date(row.selected_at)
    );
  }

  toDatabase(): any {
    return {
      id: this.id,
      league_season_id: this.leagueSeasonId,
      roster_id: this.rosterId,
      player_id: this.playerId,
      draft_pick_asset_id: this.draftPickAssetId,
      keeper_round_cost: this.keeperRoundCost,
      selected_at: this.selectedAt,
    };
  }

  /**
   * Check if this keeper selection is for a player (vs a pick asset)
   */
  isPlayer(): boolean {
    return this.playerId !== null;
  }

  /**
   * Check if this keeper selection is for a pick asset (vs a player)
   */
  isPickAsset(): boolean {
    return this.draftPickAssetId !== null;
  }

  /**
   * Check if this keeper has a cost associated with it
   */
  hasCost(): boolean {
    return this.keeperRoundCost !== null && this.keeperRoundCost > 0;
  }
}

export interface CreateKeeperSelectionParams {
  leagueSeasonId: number;
  rosterId: number;
  playerId?: number;
  draftPickAssetId?: number;
  keeperRoundCost?: number;
}

export interface KeeperSelectionWithDetails extends KeeperSelection {
  playerName?: string;
  playerPosition?: string;
  playerTeam?: string;
  pickAssetLabel?: string;
}
