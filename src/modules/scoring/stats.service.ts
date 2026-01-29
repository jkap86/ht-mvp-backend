import { SleeperApiClient, SleeperPlayerStats } from '../players/sleeper.client';
import { PlayerStatsRepository } from './scoring.repository';
import { PlayerRepository } from '../players/players.repository';
import { PlayerStats } from './scoring.model';
import { logger } from '../../config/env.config';

export interface StatsSyncResult {
  synced: number;
  skipped: number;
  total: number;
}

export class StatsService {
  constructor(
    private readonly sleeperClient: SleeperApiClient,
    private readonly statsRepo: PlayerStatsRepository,
    private readonly playerRepo: PlayerRepository
  ) {}

  /**
   * Sync weekly player stats from Sleeper API
   * @param season - NFL season year
   * @param week - Week number (1-18)
   */
  async syncWeeklyStats(season: number, week: number): Promise<StatsSyncResult> {
    logger.info(`Syncing stats for ${season} week ${week}...`);

    // Fetch stats from Sleeper
    const sleeperStats = await this.sleeperClient.fetchWeeklyStats(season.toString(), week);
    const sleeperIds = Object.keys(sleeperStats);
    logger.info(`Fetched ${sleeperIds.length} player stats from Sleeper`);

    // Get sleeper_id -> player_id mapping
    const sleeperIdMap = await this.playerRepo.getSleeperIdMap();
    logger.info(`Found ${sleeperIdMap.size} players with sleeper IDs`);

    // Transform and prepare stats for bulk upsert
    const statsToUpsert: Array<
      Partial<PlayerStats> & { playerId: number; season: number; week: number }
    > = [];
    let skipped = 0;

    for (const sleeperId of sleeperIds) {
      const playerId = sleeperIdMap.get(sleeperId);
      if (!playerId) {
        skipped++;
        continue;
      }

      const sleeper = sleeperStats[sleeperId];
      const transformed = this.mapSleeperStatsToPlayerStats(sleeper, playerId, season, week);
      statsToUpsert.push(transformed);
    }

    // Bulk upsert stats
    if (statsToUpsert.length > 0) {
      await this.statsRepo.bulkUpsert(statsToUpsert);
    }

    logger.info(`Stats sync complete: ${statsToUpsert.length} synced, ${skipped} skipped`);

    return {
      synced: statsToUpsert.length,
      skipped,
      total: sleeperIds.length,
    };
  }

  /**
   * Sync weekly player projections from Sleeper API
   * Projections are stored in the same player_stats table with a different source marker
   * @param season - NFL season year
   * @param week - Week number (1-18)
   */
  async syncWeeklyProjections(season: number, week: number): Promise<StatsSyncResult> {
    logger.info(`Syncing projections for ${season} week ${week}...`);

    // Fetch projections from Sleeper
    const sleeperProjections = await this.sleeperClient.fetchWeeklyProjections(
      season.toString(),
      week
    );
    const sleeperIds = Object.keys(sleeperProjections);
    logger.info(`Fetched ${sleeperIds.length} player projections from Sleeper`);

    // Get sleeper_id -> player_id mapping
    const sleeperIdMap = await this.playerRepo.getSleeperIdMap();

    // Transform and prepare stats for bulk upsert
    const projectionsToUpsert: Array<
      Partial<PlayerStats> & { playerId: number; season: number; week: number }
    > = [];
    let skipped = 0;

    for (const sleeperId of sleeperIds) {
      const playerId = sleeperIdMap.get(sleeperId);
      if (!playerId) {
        skipped++;
        continue;
      }

      const sleeper = sleeperProjections[sleeperId];
      const transformed = this.mapSleeperStatsToPlayerStats(sleeper, playerId, season, week);
      projectionsToUpsert.push(transformed);
    }

    // Note: For projections, we might want a separate table in the future
    // For now, actual stats will overwrite projections when the week is complete
    if (projectionsToUpsert.length > 0) {
      await this.statsRepo.bulkUpsert(projectionsToUpsert);
    }

    logger.info(
      `Projections sync complete: ${projectionsToUpsert.length} synced, ${skipped} skipped`
    );

    return {
      synced: projectionsToUpsert.length,
      skipped,
      total: sleeperIds.length,
    };
  }

  /**
   * Get the current NFL week from Sleeper
   */
  async getCurrentNflWeek(): Promise<{ season: string; week: number }> {
    const nflState = await this.sleeperClient.fetchNflState();
    return {
      season: nflState.season,
      week: nflState.week,
    };
  }

  /**
   * Transform Sleeper stats format to internal PlayerStats format
   */
  private mapSleeperStatsToPlayerStats(
    sleeper: SleeperPlayerStats,
    playerId: number,
    season: number,
    week: number
  ): Partial<PlayerStats> & { playerId: number; season: number; week: number } {
    return {
      playerId,
      season,
      week,
      // Passing
      passYards: sleeper.pass_yd || 0,
      passTd: sleeper.pass_td || 0,
      passInt: sleeper.pass_int || 0,
      // Rushing
      rushYards: sleeper.rush_yd || 0,
      rushTd: sleeper.rush_td || 0,
      // Receiving
      receptions: sleeper.rec || 0,
      recYards: sleeper.rec_yd || 0,
      recTd: sleeper.rec_td || 0,
      // Misc - sum up all 2pt conversions
      fumblesLost: sleeper.fum_lost || 0,
      twoPtConversions: (sleeper.pass_2pt || 0) + (sleeper.rush_2pt || 0) + (sleeper.rec_2pt || 0),
      // Kicking
      fgMade: sleeper.fgm || 0,
      fgMissed: sleeper.fgmiss || 0,
      patMade: sleeper.xpm || 0,
      patMissed: sleeper.xpmiss || 0,
      // Defense
      defTd: sleeper.def_td || 0,
      defInt: sleeper.int || 0,
      defSacks: sleeper.sack || 0,
      defFumbleRec: sleeper.fum_rec || 0,
      defSafety: sleeper.safe || 0,
      defPointsAllowed: sleeper.pts_allow || 0,
    };
  }
}
