import axios, { AxiosInstance } from 'axios';

export interface SleeperNflState {
  season: string;
  leg: number;
  week: number;
  season_type: string;
  display_week: number;
  league_create_season: string;
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

/**
 * Weekly player stats from Sleeper API
 */
export interface SleeperPlayerStats {
  // Passing
  pass_yd?: number;
  pass_td?: number;
  pass_int?: number;
  pass_att?: number;
  pass_cmp?: number;
  // Rushing
  rush_yd?: number;
  rush_td?: number;
  rush_att?: number;
  // Receiving
  rec?: number;
  rec_yd?: number;
  rec_td?: number;
  rec_tgt?: number;
  // Misc
  fum_lost?: number;
  pass_2pt?: number;
  rush_2pt?: number;
  rec_2pt?: number;
  // Kicking
  fgm?: number;
  fgmiss?: number;
  xpm?: number;
  xpmiss?: number;
  // Defense/Special Teams
  def_td?: number;
  int?: number;
  sack?: number;
  fum_rec?: number;
  safe?: number;
  pts_allow?: number;
  blk_kick?: number;
  // Pre-calculated fantasy points (for reference)
  pts_std?: number;
  pts_half_ppr?: number;
  pts_ppr?: number;
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

  /**
   * Fetch weekly player stats from Sleeper API
   * @param season - NFL season year (e.g., "2024")
   * @param week - Week number (1-18 for regular season)
   * @returns Map of sleeper_player_id -> stats
   */
  async fetchWeeklyStats(season: string, week: number): Promise<Record<string, SleeperPlayerStats>> {
    try {
      const response = await this.client.get(`/stats/nfl/regular/${season}/${week}`);
      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        throw new Error(`Sleeper stats API failed: ${error.message}`);
      }
      throw error;
    }
  }

  /**
   * Fetch weekly player projections from Sleeper API
   * @param season - NFL season year (e.g., "2024")
   * @param week - Week number (1-18 for regular season)
   * @returns Map of sleeper_player_id -> projected stats
   */
  async fetchWeeklyProjections(season: string, week: number): Promise<Record<string, SleeperPlayerStats>> {
    try {
      const response = await this.client.get(`/projections/nfl/regular/${season}/${week}`);
      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        throw new Error(`Sleeper projections API failed: ${error.message}`);
      }
      throw error;
    }
  }
}
