import { PlayerRepository } from './players.repository';
import { ExternalIdRepository } from './external-ids.repository';
import { IStatsProvider } from '../../integrations/shared/stats-provider.interface';
import { CFBDApiClient } from './cfbd.client';
import { playerToResponse } from './players.model';
import { NotFoundException } from '../../utils/exceptions';
import { logger } from '../../config/logger.config';

export class PlayerService {
  constructor(
    private readonly playerRepo: PlayerRepository,
    private readonly externalIdRepo: ExternalIdRepository,
    private readonly statsProvider: IStatsProvider,
    private readonly cfbdClient?: CFBDApiClient
  ) {}

  async getAllPlayers(limit = 100, offset = 0): Promise<any[]> {
    const players = await this.playerRepo.findAll(limit, offset);
    return players.map(playerToResponse);
  }

  async getPlayerById(id: number): Promise<any> {
    const player = await this.playerRepo.findById(id);
    if (!player) {
      throw new NotFoundException('Player not found');
    }
    return playerToResponse(player);
  }

  async searchPlayers(
    query: string,
    position?: string,
    team?: string,
    playerType?: 'nfl' | 'college',
    playerPool?: ('veteran' | 'rookie' | 'college')[]
  ): Promise<any[]> {
    const players = await this.playerRepo.search(query, position, team, playerType, playerPool);
    return players.map(playerToResponse);
  }

  /**
   * Sync players from configured stats provider
   */
  async syncPlayersFromProvider(): Promise<{ synced: number; total: number }> {
    logger.info(`Starting player sync from ${this.statsProvider.providerId}`);

    const playerData = await this.statsProvider.fetchPlayerMasterData();
    const externalIds = Object.keys(playerData);

    // Filter for fantasy-relevant players only (QB, RB, WR, TE, K, DEF)
    const relevantPositions = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'];

    const playersToSync = externalIds
      .map((id) => playerData[id])
      .filter((player) => {
        // Must have a relevant position
        if (!player.position || !relevantPositions.includes(player.position)) {
          return false;
        }
        // Must have a name
        if (!player.fullName && !player.firstName) {
          return false;
        }
        return true;
      });

    logger.info('Found fantasy-relevant players to sync', { count: playersToSync.length });

    // Use batch upsert for much better performance (100 players per batch)
    const syncedCount = await this.playerRepo.batchUpsertFromProvider(
      playersToSync,
      this.statsProvider.providerId,
      this.externalIdRepo,
      100
    );

    logger.info('Player sync complete', { synced: syncedCount });

    const totalCount = await this.playerRepo.getPlayerCount();

    return { synced: syncedCount, total: totalCount };
  }

  /**
   * @deprecated Use syncPlayersFromProvider() instead
   * Kept for backward compatibility during migration
   */
  async syncPlayersFromSleeper(): Promise<{ synced: number; total: number }> {
    return this.syncPlayersFromProvider();
  }

  async getNflState(): Promise<any> {
    const nflState = await this.statsProvider.fetchNflState();
    return {
      season: nflState.season.toString(),
      week: nflState.week,
      season_type: nflState.seasonType,
      display_week: nflState.displayWeek,
    };
  }

  /**
   * Sync college football players from CFBD API
   * Fetches all FBS team rosters for the given year
   */
  async syncCollegePlayersFromCFBD(year?: number, incremental = true): Promise<{ synced: number; total: number }> {
    if (!this.cfbdClient) {
      throw new Error('CFBD API client not configured. Please set CFBD_API_KEY environment variable.');
    }

    // Default to 2025 (current college season) - CFBD may not have future year data
    const currentYear = new Date().getFullYear();
    const syncYear = year || (currentYear > 2025 ? 2025 : currentYear);
    logger.info('Starting college player sync from CFBD API', { year: syncYear });

    // Get already-synced teams to skip (incremental sync)
    const skipTeams = incremental ? await this.playerRepo.getSyncedCollegeTeams() : [];
    const players = await this.cfbdClient.fetchAllFBSRosters(syncYear, skipTeams);

    // Filter for relevant positions (QB, RB, WR, TE, K - same as fantasy)
    const relevantPositions = ['QB', 'RB', 'WR', 'TE', 'K', 'ATH'];
    const playersToSync = players.filter((player) => {
      if (!player.position || !relevantPositions.includes(player.position)) {
        return false;
      }
      if (!player.firstName && !player.lastName) {
        return false;
      }
      return true;
    });

    logger.info('Found fantasy-relevant college players to sync', { count: playersToSync.length });

    const syncedCount = await this.playerRepo.batchUpsertFromCFBD(playersToSync, 100);

    logger.info('College player sync complete', { synced: syncedCount });

    const totalCount = await this.playerRepo.getCollegePlayerCount();

    return { synced: syncedCount, total: totalCount };
  }
}
