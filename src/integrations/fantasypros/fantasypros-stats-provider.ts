import { IStatsProvider } from '../shared/stats-provider.interface';
import {
  NflState,
  PlayerStatLine,
  PlayerMasterData,
} from '../shared/stats-provider.types';

/**
 * FantasyPros (or other paid provider) implementation stub
 *
 * This is a placeholder implementation that demonstrates how to add a new provider.
 * When a paid stats provider is integrated in the future, this stub will be replaced
 * with actual API integration code.
 *
 * The implementation follows the same pattern as SleeperStatsProvider:
 * 1. Call the provider's API
 * 2. Transform provider-specific responses → domain DTOs
 * 3. Return provider-agnostic data structures
 */
export class FantasyProsStatsProvider implements IStatsProvider {
  readonly providerId = 'fantasypros';

  constructor(private readonly apiKey: string) {
    if (!apiKey) {
      throw new Error('FantasyPros API key is required');
    }
  }

  async fetchNflState(): Promise<NflState> {
    throw new Error('FantasyPros provider not yet implemented');
    // TODO: Implement FantasyPros API call
    // Example:
    // const response = await fetch('https://api.fantasypros.com/v1/nfl/state', {
    //   headers: { 'X-API-Key': this.apiKey }
    // });
    // const data = await response.json();
    // return this.transformFantasyProsStateToNflState(data);
  }

  async fetchWeeklyStats(season: number, week: number): Promise<Record<string, PlayerStatLine>> {
    throw new Error('FantasyPros provider not yet implemented');
    // TODO: Implement FantasyPros API call
    // const response = await fetch(
    //   `https://api.fantasypros.com/v1/nfl/stats/${season}/${week}`,
    //   { headers: { 'X-API-Key': this.apiKey } }
    // );
    // const data = await response.json();
    // return this.transformFantasyProsStatsToStatLines(data);
  }

  async fetchWeeklyProjections(
    season: number,
    week: number
  ): Promise<Record<string, PlayerStatLine>> {
    throw new Error('FantasyPros provider not yet implemented');
    // TODO: Implement FantasyPros API call
  }

  async fetchPlayerMasterData(): Promise<Record<string, PlayerMasterData>> {
    throw new Error('FantasyPros provider not yet implemented');
    // TODO: Implement FantasyPros API call
  }
}
