import { IStatsProvider } from '../shared/stats-provider.interface';
import {
  NflState,
  PlayerStatLine,
  PlayerMasterData,
} from '../shared/stats-provider.types';
import {
  SleeperApiClient,
  SleeperNflState,
  SleeperPlayerStats,
  SleeperPlayer,
} from './sleeper-api-client';

/**
 * Sleeper implementation of IStatsProvider
 *
 * This provider wraps the existing SleeperApiClient and transforms Sleeper-specific
 * data structures into the provider-agnostic domain DTOs used throughout the application.
 *
 * All Sleeper-specific logic is isolated to this file and the SleeperApiClient.
 */
export class SleeperStatsProvider implements IStatsProvider {
  readonly providerId = 'sleeper';

  constructor(private readonly client: SleeperApiClient) {}

  /**
   * Fetch current NFL state from Sleeper API
   */
  async fetchNflState(): Promise<NflState> {
    const sleeperState: SleeperNflState = await this.client.fetchNflState();
    return this.mapSleeperNflStateToNflState(sleeperState);
  }

  /**
   * Fetch weekly player stats from Sleeper API
   */
  async fetchWeeklyStats(season: number, week: number): Promise<Record<string, PlayerStatLine>> {
    const sleeperStats = await this.client.fetchWeeklyStats(season.toString(), week);
    const result: Record<string, PlayerStatLine> = {};

    for (const [externalId, stats] of Object.entries(sleeperStats)) {
      result[externalId] = this.mapSleeperStatsToStatLine(stats, externalId);
    }

    return result;
  }

  /**
   * Fetch weekly player projections from Sleeper API
   */
  async fetchWeeklyProjections(
    season: number,
    week: number
  ): Promise<Record<string, PlayerStatLine>> {
    const sleeperProj = await this.client.fetchWeeklyProjections(season.toString(), week);
    const result: Record<string, PlayerStatLine> = {};

    for (const [externalId, stats] of Object.entries(sleeperProj)) {
      result[externalId] = this.mapSleeperStatsToStatLine(stats, externalId);
    }

    return result;
  }

  /**
   * Fetch player master data from Sleeper API
   */
  async fetchPlayerMasterData(): Promise<Record<string, PlayerMasterData>> {
    const sleeperPlayers = await this.client.fetchNflPlayers();
    const result: Record<string, PlayerMasterData> = {};

    for (const [externalId, player] of Object.entries(sleeperPlayers)) {
      result[externalId] = this.mapSleeperPlayerToMasterData(player, externalId);
    }

    return result;
  }

  /**
   * Transform Sleeper NFL state to domain DTO
   */
  private mapSleeperNflStateToNflState(sleeperState: SleeperNflState): NflState {
    return {
      season: parseInt(sleeperState.season, 10),
      week: sleeperState.week,
      seasonType: this.mapSeasonType(sleeperState.season_type),
      displayWeek: sleeperState.display_week,
    };
  }

  /**
   * Transform Sleeper player stats to domain stat line
   */
  private mapSleeperStatsToStatLine(
    stats: SleeperPlayerStats,
    externalId: string
  ): PlayerStatLine {
    return {
      externalId,
      // Passing
      passYards: stats.pass_yd,
      passTd: stats.pass_td,
      passInt: stats.pass_int,
      passAtt: stats.pass_att,
      passCmp: stats.pass_cmp,
      // Rushing
      rushYards: stats.rush_yd,
      rushTd: stats.rush_td,
      rushAtt: stats.rush_att,
      // Receiving
      receptions: stats.rec,
      recYards: stats.rec_yd,
      recTd: stats.rec_td,
      recTargets: stats.rec_tgt,
      // Misc
      fumblesLost: stats.fum_lost,
      pass2pt: stats.pass_2pt,
      rush2pt: stats.rush_2pt,
      rec2pt: stats.rec_2pt,
      // Kicking
      fgMade: stats.fgm,
      fgMissed: stats.fgmiss,
      xpMade: stats.xpm,
      xpMissed: stats.xpmiss,
      // Defense/ST
      defTd: stats.def_td,
      defInt: stats.int,
      defSacks: stats.sack,
      defFumbleRec: stats.fum_rec,
      defSafety: stats.safe,
      defPointsAllowed: stats.pts_allow,
      defBlkKick: stats.blk_kick,
    };
  }

  /**
   * Transform Sleeper player data to domain master data
   */
  private mapSleeperPlayerToMasterData(
    player: SleeperPlayer,
    externalId: string
  ): PlayerMasterData {
    return {
      externalId,
      firstName: player.first_name || null,
      lastName: player.last_name || null,
      fullName: player.full_name,
      position: player.position || null,
      team: player.team || null,
      jerseyNumber: player.number || null,
      yearsExp: player.years_exp || null,
      age: player.age || null,
      active: player.active,
      status: player.status || null,
      injuryStatus: player.injury_status || null,
    };
  }

  /**
   * Map Sleeper season type to domain season type
   */
  private mapSeasonType(sleeperType: string): 'preseason' | 'regular' | 'postseason' {
    if (sleeperType === 'pre') return 'preseason';
    if (sleeperType === 'post') return 'postseason';
    return 'regular';
  }
}
