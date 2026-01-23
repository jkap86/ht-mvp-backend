import axios, { AxiosInstance } from 'axios';

export interface SleeperNflState {
  season: string;
  leg: number;
  week: number;
  season_type: string;
  display_week: number;
}

export interface SleeperPlayer {
  player_id: string;
  first_name: string;
  last_name: string;
  full_name: string;
  fantasy_positions: string[];
  position: string;
  team: string;
  years_exp: number;
  age: number;
  active: boolean;
  status: string;
  injury_status: string;
  number: number;
}

export class SleeperApiClient {
  private readonly client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      baseURL: 'https://api.sleeper.app/v1',
      timeout: 30000,
      headers: { 'Accept': 'application/json' },
    });
  }

  async fetchNflState(): Promise<SleeperNflState> {
    try {
      const response = await this.client.get('/state/nfl');
      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        throw new Error(`Sleeper NFL state API failed: ${error.message}`);
      }
      throw error;
    }
  }

  async fetchNflPlayers(): Promise<Record<string, SleeperPlayer>> {
    try {
      const response = await this.client.get('/players/nfl');
      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        throw new Error(`Sleeper players API failed: ${error.message}`);
      }
      throw error;
    }
  }
}
