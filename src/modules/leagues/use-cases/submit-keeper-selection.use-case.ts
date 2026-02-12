/**
 * Submit Keeper Selection Use Case
 * Allows rosters to submit their keeper selections for the upcoming season
 */

import { Pool, PoolClient } from 'pg';
import { LeagueSeasonRepository } from '../league-season.repository';
import { KeeperSelectionRepository, CreateKeeperSelectionParams } from '../keeper-selection.repository';
import { LeagueRepository } from '../leagues.repository';
import { KeeperSelection } from '../keeper-selection.model';
import { NotFoundException, ValidationException, ConflictException } from '../../../utils/exceptions';

export interface SubmitKeepersParams {
  leagueSeasonId: number;
  rosterId: number;
  selections: Array<{
    playerId?: number;
    draftPickAssetId?: number;
    keeperRoundCost?: number;
  }>;
  userId?: string; // For permission validation
}

export class SubmitKeeperSelectionUseCase {
  constructor(
    private readonly pool: Pool,
    private readonly leagueSeasonRepo: LeagueSeasonRepository,
    private readonly keeperRepo: KeeperSelectionRepository,
    private readonly leagueRepo: LeagueRepository
  ) {}

  async execute(params: SubmitKeepersParams): Promise<KeeperSelection[]> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      // 1. Get season and validate it exists
      const season = await this.leagueSeasonRepo.findById(params.leagueSeasonId, client);
      if (!season) {
        throw new NotFoundException('League season not found');
      }

      // 2. Validate keeper deadline hasn't passed
      if (season.isKeeperDeadlinePassed()) {
        throw new ValidationException('Keeper deadline has passed. Cannot submit keeper selections.');
      }

      // 3. Validate season is in correct status (pre_draft)
      if (season.status !== 'pre_draft') {
        throw new ValidationException('Keeper selections can only be submitted during pre_draft status');
      }

      // 4. Get league and validate keeper count
      const league = await this.leagueRepo.findById(season.leagueId, client);
      if (!league) {
        throw new NotFoundException('League not found');
      }

      const maxKeepers = season.getMaxKeepers();
      if (params.selections.length > maxKeepers) {
        throw new ValidationException(`Cannot keep more than ${maxKeepers} players. You selected ${params.selections.length}.`);
      }

      // 5. Validate roster belongs to this league season
      const rosterCheck = await client.query(
        'SELECT 1 FROM rosters WHERE id = $1 AND league_season_id = $2',
        [params.rosterId, params.leagueSeasonId]
      );
      if (rosterCheck.rows.length === 0) {
        throw new NotFoundException('Roster not found in this league season');
      }

      // 6. Validate each selection
      await this.validateSelections(client, params.selections, params.leagueSeasonId);

      // 7. Delete existing keeper selections for this roster (allows updating selections)
      await this.keeperRepo.deleteByRoster(params.rosterId, params.leagueSeasonId, client);

      // 8. Insert new keeper selections
      const createdKeepers: KeeperSelection[] = [];
      if (params.selections.length > 0) {
        const createParams: CreateKeeperSelectionParams[] = params.selections.map(sel => ({
          leagueSeasonId: params.leagueSeasonId,
          rosterId: params.rosterId,
          playerId: sel.playerId,
          draftPickAssetId: sel.draftPickAssetId,
          keeperRoundCost: sel.keeperRoundCost
        }));

        const keepers = await this.keeperRepo.bulkCreate(createParams, client);
        createdKeepers.push(...keepers);
      }

      await client.query('COMMIT');

      return createdKeepers;

    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Validate keeper selections:
   * - Each selection has either playerId OR draftPickAssetId
   * - Players/assets exist
   * - Players/assets aren't already kept by another roster
   */
  private async validateSelections(
    client: PoolClient,
    selections: Array<{ playerId?: number; draftPickAssetId?: number; keeperRoundCost?: number }>,
    leagueSeasonId: number
  ): Promise<void> {
    for (const selection of selections) {
      // Validate XOR
      if ((selection.playerId === undefined && selection.draftPickAssetId === undefined) ||
          (selection.playerId !== undefined && selection.draftPickAssetId !== undefined)) {
        throw new ValidationException('Each keeper selection must have either playerId or draftPickAssetId, not both or neither');
      }

      // Validate player exists
      if (selection.playerId) {
        const playerCheck = await client.query(
          'SELECT 1 FROM players WHERE id = $1',
          [selection.playerId]
        );
        if (playerCheck.rows.length === 0) {
          throw new NotFoundException(`Player with ID ${selection.playerId} not found`);
        }

        // Check if player is already kept by another roster
        const existingKeeper = await client.query(
          `SELECT r.roster_id FROM keeper_selections ks
           JOIN rosters r ON ks.roster_id = r.id
           WHERE ks.player_id = $1 AND ks.league_season_id = $2`,
          [selection.playerId, leagueSeasonId]
        );
        if (existingKeeper.rows.length > 0) {
          throw new ConflictException(`Player ${selection.playerId} is already kept by roster ${existingKeeper.rows[0].roster_id}`);
        }
      }

      // Validate pick asset exists
      if (selection.draftPickAssetId) {
        const assetCheck = await client.query(
          'SELECT 1 FROM draft_pick_assets WHERE id = $1',
          [selection.draftPickAssetId]
        );
        if (assetCheck.rows.length === 0) {
          throw new NotFoundException(`Draft pick asset with ID ${selection.draftPickAssetId} not found`);
        }

        // Check if pick asset is already kept by another roster
        const existingKeeper = await client.query(
          `SELECT r.roster_id FROM keeper_selections ks
           JOIN rosters r ON ks.roster_id = r.id
           WHERE ks.draft_pick_asset_id = $1 AND ks.league_season_id = $2`,
          [selection.draftPickAssetId, leagueSeasonId]
        );
        if (existingKeeper.rows.length > 0) {
          throw new ConflictException(`Pick asset ${selection.draftPickAssetId} is already kept by roster ${existingKeeper.rows[0].roster_id}`);
        }
      }
    }
  }
}
