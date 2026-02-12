/**
 * Apply Keepers to Rosters Use Case
 * Applies keeper selections to rosters after keeper deadline passes
 * Adds kept players to roster_players table
 */

import { Pool, PoolClient } from 'pg';
import { KeeperSelectionRepository } from '../keeper-selection.repository';
import { LeagueSeasonRepository } from '../league-season.repository';

export class ApplyKeepersToRostersUseCase {
  constructor(
    private readonly pool: Pool,
    private readonly keeperRepo: KeeperSelectionRepository,
    private readonly leagueSeasonRepo: LeagueSeasonRepository
  ) {}

  async execute(leagueSeasonId: number): Promise<{ playersAdded: number; assetsKept: number }> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      // 1. Verify season exists
      const season = await this.leagueSeasonRepo.findById(leagueSeasonId, client);
      if (!season) {
        throw new Error('League season not found');
      }

      // 2. Verify keeper deadline has passed (optional check)
      if (!season.isKeeperDeadlinePassed()) {
        throw new Error('Keeper deadline has not passed yet. Cannot apply keepers.');
      }

      // 3. Verify season is still in pre_draft status
      if (season.status !== 'pre_draft') {
        throw new Error('Keepers can only be applied during pre_draft status');
      }

      // 4. Get all keeper selections for this season
      const keepers = await this.keeperRepo.findByLeagueSeason(leagueSeasonId, client);

      let playersAdded = 0;
      let assetsKept = 0;

      // 5. Apply each keeper selection
      for (const keeper of keepers) {
        if (keeper.isPlayer()) {
          // Add kept player to roster_players table
          const existing = await client.query(
            'SELECT 1 FROM roster_players WHERE roster_id = $1 AND player_id = $2',
            [keeper.rosterId, keeper.playerId]
          );

          if (existing.rows.length === 0) {
            await client.query(
              `INSERT INTO roster_players (roster_id, player_id, acquired_via)
               VALUES ($1, $2, 'keeper')`,
              [keeper.rosterId, keeper.playerId]
            );
            playersAdded++;
          }
        } else if (keeper.isPickAsset()) {
          // Pick assets don't need to be applied to roster_players
          // They're already owned and tracked in draft_pick_assets table
          assetsKept++;
        }
      }

      await client.query('COMMIT');

      return { playersAdded, assetsKept };

    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Apply keepers for a specific roster only
   */
  async executeForRoster(
    leagueSeasonId: number,
    rosterId: number
  ): Promise<{ playersAdded: number; assetsKept: number }> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      // Get keeper selections for this roster
      const keepers = await this.keeperRepo.findByRoster(rosterId, leagueSeasonId, client);

      let playersAdded = 0;
      let assetsKept = 0;

      for (const keeper of keepers) {
        if (keeper.isPlayer()) {
          const existing = await client.query(
            'SELECT 1 FROM roster_players WHERE roster_id = $1 AND player_id = $2',
            [keeper.rosterId, keeper.playerId]
          );

          if (existing.rows.length === 0) {
            await client.query(
              `INSERT INTO roster_players (roster_id, player_id, acquired_via)
               VALUES ($1, $2, 'keeper')`,
              [keeper.rosterId, keeper.playerId]
            );
            playersAdded++;
          }
        } else if (keeper.isPickAsset()) {
          assetsKept++;
        }
      }

      await client.query('COMMIT');

      return { playersAdded, assetsKept };

    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Check if keepers have been applied for a league season
   */
  async areKeepersApplied(leagueSeasonId: number): Promise<boolean> {
    // Check if any roster_players exist with acquired_via='keeper' for rosters in this season
    const result = await this.pool.query(
      `SELECT COUNT(*) as count FROM roster_players rp
       JOIN rosters r ON rp.roster_id = r.id
       WHERE r.league_season_id = $1 AND rp.acquired_via = 'keeper'`,
      [leagueSeasonId]
    );

    return (Number(result.rows[0].count) || 0) > 0;
  }
}
