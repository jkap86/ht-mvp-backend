import axios, { AxiosError, AxiosInstance } from 'axios';
import { logger } from '../../config/logger.config';

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

/**
 * Sleeper player news/update (derived from player status changes)
 */
export interface SleeperPlayerNews {
  player_id: string;
  title: string;
  description: string;
  timestamp: string; // ISO date
  news_type: 'injury' | 'transaction' | 'general';
  impact_level: 'critical' | 'high' | 'normal' | 'low';
}

/** Network error codes that indicate transient failures worth retrying */
const TRANSIENT_NETWORK_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ECONNABORTED',
  'EPIPE',
  'ENOTFOUND',
  'ENETUNREACH',
  'EAI_AGAIN',
]);

/**
 * Determines if an Axios error represents a transient failure that should be retried.
 * Returns true for 5xx server errors, timeouts, and network-level errors.
 * Returns false for 4xx client errors (permanent failures).
 */
function isTransientError(error: unknown): boolean {
  if (!axios.isAxiosError(error)) return false;

  const axiosErr = error as AxiosError;

  // Network-level errors (no response received)
  if (axiosErr.code && TRANSIENT_NETWORK_CODES.has(axiosErr.code)) return true;

  // Axios timeout
  if (axiosErr.code === 'ECONNABORTED' || axiosErr.message?.includes('timeout')) return true;

  // 5xx server errors are transient
  const status = axiosErr.response?.status;
  if (status !== undefined && status >= 500) return true;

  // 4xx and other responses are not transient
  return false;
}

export class SleeperApiClient {
  private readonly client: AxiosInstance;
  private readonly maxRetries = 3;
  private readonly baseDelayMs = 1000;

  constructor() {
    this.client = axios.create({
      baseURL: 'https://api.sleeper.app/v1',
      timeout: 30000,
      headers: { Accept: 'application/json' },
    });
  }

  /**
   * Execute a request with retry logic for transient failures.
   * Retries on 5xx errors, timeouts, and network errors with exponential backoff (1s, 2s, 4s).
   * Does NOT retry on 4xx client errors (permanent failures).
   */
  private async withRetry<T>(fn: () => Promise<T>, context: string): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        if (attempt < this.maxRetries && isTransientError(error)) {
          lastError = error as Error;
          const delay = this.baseDelayMs * Math.pow(2, attempt);
          logger.warn('Sleeper API transient error, retrying', {
            context,
            attempt: attempt + 1,
            maxRetries: this.maxRetries,
            delay,
            errorMessage: (error as Error).message,
            errorCode: axios.isAxiosError(error) ? error.code : undefined,
            status: axios.isAxiosError(error) ? error.response?.status : undefined,
          });
          await new Promise(resolve => setTimeout(resolve, delay));
        } else {
          throw error;
        }
      }
    }

    throw lastError || new Error(`Sleeper API max retries exceeded for ${context}`);
  }

  async fetchNflState(): Promise<SleeperNflState> {
    return this.withRetry(async () => {
      try {
        const response = await this.client.get('/state/nfl');
        return response.data;
      } catch (error) {
        if (axios.isAxiosError(error) && !isTransientError(error)) {
          throw new Error(`Sleeper NFL state API failed: ${error.message}`);
        }
        throw error;
      }
    }, 'state/nfl');
  }

  async fetchNflPlayers(): Promise<Record<string, SleeperPlayer>> {
    return this.withRetry(async () => {
      try {
        const response = await this.client.get('/players/nfl');
        return response.data;
      } catch (error) {
        if (axios.isAxiosError(error) && !isTransientError(error)) {
          throw new Error(`Sleeper players API failed: ${error.message}`);
        }
        throw error;
      }
    }, 'players/nfl');
  }

  /**
   * Fetch weekly player stats from Sleeper API
   * @param season - NFL season year (e.g., "2024")
   * @param week - Week number (1-18 for regular season)
   * @returns Map of sleeper_player_id -> stats
   */
  async fetchWeeklyStats(
    season: string,
    week: number
  ): Promise<Record<string, SleeperPlayerStats>> {
    return this.withRetry(async () => {
      try {
        const response = await this.client.get(`/stats/nfl/regular/${season}/${week}`);
        return response.data;
      } catch (error) {
        if (axios.isAxiosError(error) && !isTransientError(error)) {
          throw new Error(`Sleeper stats API failed: ${error.message}`);
        }
        throw error;
      }
    }, `stats/nfl/regular/${season}/${week}`);
  }

  /**
   * Fetch weekly player projections from Sleeper API
   * @param season - NFL season year (e.g., "2024")
   * @param week - Week number (1-18 for regular season)
   * @returns Map of sleeper_player_id -> projected stats
   */
  async fetchWeeklyProjections(
    season: string,
    week: number
  ): Promise<Record<string, SleeperPlayerStats>> {
    return this.withRetry(async () => {
      try {
        const response = await this.client.get(`/projections/nfl/regular/${season}/${week}`);
        return response.data;
      } catch (error) {
        if (axios.isAxiosError(error) && !isTransientError(error)) {
          throw new Error(`Sleeper projections API failed: ${error.message}`);
        }
        throw error;
      }
    }, `projections/nfl/regular/${season}/${week}`);
  }

  /**
   * Detect player status changes to generate news
   * Compares current player data with previous data to identify changes
   * Note: Sleeper doesn't have a dedicated news API, so we derive news from status changes
   * For production, integrate with ESPN, RotoBaller, or FantasyData news APIs
   */
  async derivePlayerNewsFromChanges(
    currentPlayers: Record<string, SleeperPlayer>,
    previousPlayers: Record<string, SleeperPlayer>
  ): Promise<SleeperPlayerNews[]> {
    const news: SleeperPlayerNews[] = [];

    for (const [playerId, currentPlayer] of Object.entries(currentPlayers)) {
      const previousPlayer = previousPlayers[playerId];
      if (!previousPlayer) continue;

      // Injury status change
      if (currentPlayer.injury_status !== previousPlayer.injury_status) {
        let impactLevel: 'critical' | 'high' | 'normal' | 'low' = 'normal';
        let title = '';

        if (currentPlayer.injury_status === 'Out') {
          impactLevel = 'critical';
          title = `${currentPlayer.full_name} ruled OUT`;
        } else if (currentPlayer.injury_status === 'Doubtful') {
          impactLevel = 'high';
          title = `${currentPlayer.full_name} listed as DOUBTFUL`;
        } else if (currentPlayer.injury_status === 'Questionable') {
          impactLevel = 'high';
          title = `${currentPlayer.full_name} listed as QUESTIONABLE`;
        } else if (currentPlayer.injury_status === 'Probable') {
          impactLevel = 'normal';
          title = `${currentPlayer.full_name} listed as PROBABLE`;
        } else if (previousPlayer.injury_status && !currentPlayer.injury_status) {
          impactLevel = 'normal';
          title = `${currentPlayer.full_name} cleared from injury report`;
        }

        if (title) {
          news.push({
            player_id: playerId,
            title,
            description: `Injury status changed from ${previousPlayer.injury_status || 'Healthy'} to ${currentPlayer.injury_status || 'Healthy'}`,
            timestamp: new Date().toISOString(),
            news_type: 'injury',
            impact_level: impactLevel,
          });
        }
      }

      // Team change (trade/signing)
      if (currentPlayer.team !== previousPlayer.team) {
        news.push({
          player_id: playerId,
          title: `${currentPlayer.full_name} moved to ${currentPlayer.team || 'Free Agent'}`,
          description: `${currentPlayer.full_name} has been moved from ${previousPlayer.team || 'Free Agent'} to ${currentPlayer.team || 'Free Agent'}`,
          timestamp: new Date().toISOString(),
          news_type: 'transaction',
          impact_level: 'high',
        });
      }

      // Active status change (waived, signed, IR)
      if (currentPlayer.active !== previousPlayer.active) {
        const impactLevel = currentPlayer.active ? 'normal' : 'high';
        news.push({
          player_id: playerId,
          title: currentPlayer.active
            ? `${currentPlayer.full_name} activated`
            : `${currentPlayer.full_name} deactivated`,
          description: currentPlayer.active
            ? `${currentPlayer.full_name} has been activated and is now eligible to play`
            : `${currentPlayer.full_name} has been deactivated (IR, waived, or released)`,
          timestamp: new Date().toISOString(),
          news_type: 'transaction',
          impact_level: impactLevel,
        });
      }
    }

    return news;
  }
}
