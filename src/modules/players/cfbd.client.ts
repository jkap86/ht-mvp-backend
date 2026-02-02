import axios, { AxiosInstance } from 'axios';

export interface CFBDPlayer {
  id: string;
  firstName: string;
  lastName: string;
  team: string;
  height: number;
  weight: number;
  jersey: number;
  year: number;
  position: string;
  homeCity: string;
  homeState: string;
  homeCountry: string;
}

export interface CFBDTeam {
  id: number;
  school: string;
  mascot: string;
  abbreviation: string;
  conference: string;
  division: string;
}

export class CFBDApiClient {
  private readonly client: AxiosInstance;
  private readonly maxRetries = 3;
  private readonly baseDelayMs = 2000;

  constructor(apiKey: string) {
    this.client = axios.create({
      baseURL: 'https://api.collegefootballdata.com',
      timeout: 30000,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
    });
  }

  /**
   * Execute request with retry logic for rate limits
   */
  private async withRetry<T>(fn: () => Promise<T>, context: string): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        if (axios.isAxiosError(error) && error.response?.status === 429) {
          lastError = error;
          const delay = this.baseDelayMs * Math.pow(2, attempt);
          console.log(`Rate limited on ${context}, retrying in ${delay}ms (attempt ${attempt + 1}/${this.maxRetries})`);
          await new Promise(resolve => setTimeout(resolve, delay));
        } else {
          throw error;
        }
      }
    }

    throw lastError || new Error(`Max retries exceeded for ${context}`);
  }

  /**
   * Fetch roster for a specific team
   * @param year - Season year (e.g., 2024)
   * @param team - Team name (e.g., "Alabama")
   */
  async fetchRoster(year: number, team: string): Promise<CFBDPlayer[]> {
    return this.withRetry(async () => {
      try {
        const response = await this.client.get('/roster', {
          params: { year, team },
        });
        return response.data;
      } catch (error) {
        if (axios.isAxiosError(error) && error.response?.status !== 429) {
          throw new Error(`CFBD roster API failed for ${team}: ${error.message}`);
        }
        throw error;
      }
    }, `roster/${team}`);
  }

  /**
   * Fetch all FBS teams
   */
  async fetchFBSTeams(): Promise<CFBDTeam[]> {
    return this.withRetry(async () => {
      try {
        const response = await this.client.get('/teams/fbs');
        return response.data;
      } catch (error) {
        if (axios.isAxiosError(error) && error.response?.status !== 429) {
          throw new Error(`CFBD teams API failed: ${error.message}`);
        }
        throw error;
      }
    }, 'teams/fbs');
  }

  /**
   * Fetch rosters for all FBS teams
   * Iterates through all teams to collect complete player data
   * @param year - Season year (e.g., 2024)
   * @param skipTeams - Optional list of team names to skip (already synced)
   */
  async fetchAllFBSRosters(year: number, skipTeams: string[] = []): Promise<CFBDPlayer[]> {
    const allTeams = await this.fetchFBSTeams();

    // Filter out teams we've already synced
    const skipSet = new Set(skipTeams.map(t => t.toLowerCase()));
    const teams = allTeams.filter(t => !skipSet.has(t.school.toLowerCase()));

    if (teams.length === 0) {
      console.log(`All ${allTeams.length} FBS teams already synced, nothing to do`);
      return [];
    }

    console.log(`Fetching rosters for ${teams.length} FBS teams (${skipTeams.length} already synced)...`);

    const allPlayers: CFBDPlayer[] = [];

    // Process teams in batches to avoid rate limiting
    // Use smaller batches and longer delays to stay under rate limits
    const batchSize = 5;
    const delayBetweenBatches = 1500; // 1.5 seconds between batches

    for (let i = 0; i < teams.length; i += batchSize) {
      const batch = teams.slice(i, i + batchSize);

      const promises = batch.map(async (team) => {
        try {
          const roster = await this.fetchRoster(year, team.school);
          return roster;
        } catch (error) {
          console.warn(`Failed to fetch roster for ${team.school}:`, error);
          return [];
        }
      });

      const results = await Promise.all(promises);
      for (const roster of results) {
        allPlayers.push(...roster);
      }

      // Log progress
      const processed = Math.min(i + batchSize, teams.length);
      console.log(`Processed ${processed}/${teams.length} teams (${allPlayers.length} players so far)`);

      // Delay between batches to stay under rate limits
      if (i + batchSize < teams.length) {
        await new Promise((resolve) => setTimeout(resolve, delayBetweenBatches));
      }
    }

    console.log(`Fetched ${allPlayers.length} total players from ${teams.length} teams`);
    return allPlayers;
  }
}
