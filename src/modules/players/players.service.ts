import { PlayerRepository } from './players.repository';
import { SleeperApiClient } from './sleeper.client';
import { CFBDApiClient } from './cfbd.client';
import { playerToResponse } from './players.model';
import { NotFoundException } from '../../utils/exceptions';

export class PlayerService {
  constructor(
    private readonly playerRepo: PlayerRepository,
    private readonly sleeperClient: SleeperApiClient,
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
    playerType?: 'nfl' | 'college'
  ): Promise<any[]> {
    const players = await this.playerRepo.search(query, position, team, playerType);
    return players.map(playerToResponse);
  }

  async syncPlayersFromSleeper(): Promise<{ synced: number; total: number }> {
    console.log('Starting player sync from Sleeper API...');

    const players = await this.sleeperClient.fetchNflPlayers();
    const playerIds = Object.keys(players);

    // Filter for fantasy-relevant players only (QB, RB, WR, TE, K, DEF)
    const relevantPositions = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'];

    const playersToSync = playerIds
      .map((id) => players[id])
      .filter((player) => {
        // Must have a relevant position
        if (!player.position || !relevantPositions.includes(player.position)) {
          return false;
        }
        // Must have a name
        if (!player.full_name && !player.first_name) {
          return false;
        }
        return true;
      });

    console.log(`Found ${playersToSync.length} fantasy-relevant players to sync...`);

    // Use batch upsert for much better performance (100 players per batch)
    const syncedCount = await this.playerRepo.batchUpsertFromSleeper(playersToSync, 100);

    console.log(`Player sync complete. Synced ${syncedCount} fantasy-relevant players.`);

    const totalCount = await this.playerRepo.getPlayerCount();

    return { synced: syncedCount, total: totalCount };
  }

  async getNflState(): Promise<any> {
    return this.sleeperClient.fetchNflState();
  }

  /**
   * Sync college football players from CFBD API
   * Fetches all FBS team rosters for the given year
   */
  async syncCollegePlayersFromCFBD(year?: number): Promise<{ synced: number; total: number }> {
    if (!this.cfbdClient) {
      throw new Error('CFBD API client not configured. Please set CFBD_API_KEY environment variable.');
    }

    const syncYear = year || new Date().getFullYear();
    console.log(`Starting college player sync from CFBD API for year ${syncYear}...`);

    const players = await this.cfbdClient.fetchAllFBSRosters(syncYear);

    // Filter for relevant positions (QB, RB, WR, TE, K - same as fantasy)
    const relevantPositions = ['QB', 'RB', 'WR', 'TE', 'K', 'ATH'];
    const playersToSync = players.filter((player) => {
      if (!player.position || !relevantPositions.includes(player.position)) {
        return false;
      }
      if (!player.first_name && !player.last_name) {
        return false;
      }
      return true;
    });

    console.log(`Found ${playersToSync.length} fantasy-relevant college players to sync...`);

    const syncedCount = await this.playerRepo.batchUpsertFromCFBD(playersToSync, 100);

    console.log(`College player sync complete. Synced ${syncedCount} players.`);

    const totalCount = await this.playerRepo.getCollegePlayerCount();

    return { synced: syncedCount, total: totalCount };
  }
}
