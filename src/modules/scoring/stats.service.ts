import { IStatsProvider } from '../../integrations/shared/stats-provider.interface';
import { PlayerStatLine } from '../../integrations/shared/stats-provider.types';
import { PlayerStatsRepository } from './scoring.repository';
import { PlayerProjectionsRepository } from './projections.repository';
import { ExternalIdRepository } from '../players/external-ids.repository';
import { PlayerStats } from './scoring.model';
import { logger } from '../../config/logger.config';

export interface StatsSyncResult {
  synced: number;
  skipped: number;
  total: number;
}

export class StatsService {
  constructor(
    private readonly statsProvider: IStatsProvider,
    private readonly statsRepo: PlayerStatsRepository,
    private readonly externalIdRepo: ExternalIdRepository,
    private readonly projectionsRepo?: PlayerProjectionsRepository
  ) {}

  /**
   * Sync weekly player stats from configured provider
   * @param season - NFL season year
   * @param week - Week number (1-18)
   */
  async syncWeeklyStats(season: number, week: number): Promise<StatsSyncResult> {
    logger.info(`Syncing stats for ${season} week ${week} from ${this.statsProvider.providerId}...`);

    // Fetch stats from provider
    const providerStats = await this.statsProvider.fetchWeeklyStats(season, week);
    const externalIds = Object.keys(providerStats);
    logger.info(`Fetched ${externalIds.length} player stats from ${this.statsProvider.providerId}`);

    // Get external_id -> player_id mapping
    const externalIdMap = await this.externalIdRepo.getExternalIdMap(this.statsProvider.providerId);
    logger.info(`Found ${externalIdMap.size} players with ${this.statsProvider.providerId} IDs`);

    // Transform and prepare stats for bulk upsert
    const statsToUpsert: Array<
      Partial<PlayerStats> & { playerId: number; season: number; week: number }
    > = [];
    let skipped = 0;

    for (const externalId of externalIds) {
      const playerId = externalIdMap.get(externalId);
      if (!playerId) {
        skipped++;
        continue;
      }

      const statLine = providerStats[externalId];
      const transformed = this.mapStatLineToPlayerStats(statLine, playerId, season, week);
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
      total: externalIds.length,
    };
  }

  /**
   * Sync weekly player projections from configured provider
   * Projections are stored in a separate player_projections table to avoid
   * overwriting actual stats during live games.
   * @param season - NFL season year
   * @param week - Week number (1-18)
   */
  async syncWeeklyProjections(season: number, week: number): Promise<StatsSyncResult> {
    if (!this.projectionsRepo) {
      logger.warn('ProjectionsRepository not configured, skipping projections sync');
      return { synced: 0, skipped: 0, total: 0 };
    }

    logger.info(`Syncing projections for ${season} week ${week} from ${this.statsProvider.providerId}...`);

    // Fetch projections from provider
    const providerProjections = await this.statsProvider.fetchWeeklyProjections(season, week);
    const externalIds = Object.keys(providerProjections);
    logger.info(`Fetched ${externalIds.length} player projections from ${this.statsProvider.providerId}`);

    // Get external_id -> player_id mapping
    const externalIdMap = await this.externalIdRepo.getExternalIdMap(this.statsProvider.providerId);

    // Transform and prepare projections for bulk upsert
    const projectionsToUpsert: Array<
      Partial<PlayerStats> & { playerId: number; season: number; week: number }
    > = [];
    let skipped = 0;

    for (const externalId of externalIds) {
      const playerId = externalIdMap.get(externalId);
      if (!playerId) {
        skipped++;
        continue;
      }

      const statLine = providerProjections[externalId];
      const transformed = this.mapStatLineToPlayerStats(statLine, playerId, season, week);
      projectionsToUpsert.push(transformed);
    }

    // Store projections in dedicated player_projections table
    if (projectionsToUpsert.length > 0) {
      await this.projectionsRepo.bulkUpsert(projectionsToUpsert);
    }

    logger.info(
      `Projections sync complete: ${projectionsToUpsert.length} synced, ${skipped} skipped`
    );

    return {
      synced: projectionsToUpsert.length,
      skipped,
      total: externalIds.length,
    };
  }

  /**
   * Get the current NFL week from configured provider
   */
  async getCurrentNflWeek(): Promise<{ season: string; week: number; seasonType: 'preseason' | 'regular' | 'postseason' }> {
    const nflState = await this.statsProvider.fetchNflState();
    return {
      season: nflState.season.toString(),
      week: nflState.week,
      seasonType: nflState.seasonType,
    };
  }

  /**
   * Transform provider stat line to internal PlayerStats format
   * This method is provider-agnostic - it works with the domain DTO
   */
  private mapStatLineToPlayerStats(
    statLine: PlayerStatLine,
    playerId: number,
    season: number,
    week: number
  ): Partial<PlayerStats> & { playerId: number; season: number; week: number } {
    return {
      playerId,
      season,
      week,
      // Passing
      passYards: statLine.passYards || 0,
      passTd: statLine.passTd || 0,
      passInt: statLine.passInt || 0,
      // Rushing
      rushYards: statLine.rushYards || 0,
      rushTd: statLine.rushTd || 0,
      // Receiving
      receptions: statLine.receptions || 0,
      recYards: statLine.recYards || 0,
      recTd: statLine.recTd || 0,
      // Misc - sum up all 2pt conversions
      fumblesLost: statLine.fumblesLost || 0,
      twoPtConversions:
        (statLine.pass2pt || 0) + (statLine.rush2pt || 0) + (statLine.rec2pt || 0),
      // Kicking
      fgMade: statLine.fgMade || 0,
      fgMissed: statLine.fgMissed || 0,
      patMade: statLine.xpMade || 0,
      patMissed: statLine.xpMissed || 0,
      // Defense
      defTd: statLine.defTd || 0,
      defInt: statLine.defInt || 0,
      defSacks: statLine.defSacks || 0,
      defFumbleRec: statLine.defFumbleRec || 0,
      defSafety: statLine.defSafety || 0,
      defPointsAllowed: statLine.defPointsAllowed || 0,
    };
  }
}
