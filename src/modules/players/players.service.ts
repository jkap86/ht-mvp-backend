import { PlayerRepository } from './players.repository';
import { SleeperApiClient } from './sleeper.client';
import { playerToResponse } from './players.model';
import { NotFoundException } from '../../utils/exceptions';

export class PlayerService {
  constructor(
    private readonly playerRepo: PlayerRepository,
    private readonly sleeperClient: SleeperApiClient
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

  async searchPlayers(query: string, position?: string, team?: string): Promise<any[]> {
    const players = await this.playerRepo.search(query, position, team);
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
}
