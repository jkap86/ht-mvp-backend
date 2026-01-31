import axios, { AxiosInstance } from 'axios';

export interface CFBDPlayer {
  id: number;
  first_name: string;
  last_name: string;
  team: string;
  height: number;
  weight: number;
  jersey: number;
  position: string;
  home_city: string;
  home_state: string;
  home_country: string;
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
   * Fetch roster for a specific team
   * @param year - Season year (e.g., 2024)
   * @param team - Team name (e.g., "Alabama")
   */
  async fetchRoster(year: number, team: string): Promise<CFBDPlayer[]> {
    try {
      const response = await this.client.get('/roster', {
        params: { year, team },
      });
      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        throw new Error(`CFBD roster API failed for ${team}: ${error.message}`);
      }
      throw error;
    }
  }

  /**
   * Fetch all FBS teams
   */
  async fetchFBSTeams(): Promise<CFBDTeam[]> {
    try {
      const response = await this.client.get('/teams/fbs');
      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        throw new Error(`CFBD teams API failed: ${error.message}`);
      }
      throw error;
    }
  }

  /**
   * Fetch rosters for all FBS teams
   * Iterates through all teams to collect complete player data
   * @param year - Season year (e.g., 2024)
   */
  async fetchAllFBSRosters(year: number): Promise<CFBDPlayer[]> {
    const teams = await this.fetchFBSTeams();
    const allPlayers: CFBDPlayer[] = [];

    console.log(`Fetching rosters for ${teams.length} FBS teams...`);

    // Process teams in batches to avoid rate limiting
    const batchSize = 10;
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

      // Small delay between batches to be respectful of rate limits
      if (i + batchSize < teams.length) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }

    console.log(`Fetched ${allPlayers.length} total players from ${teams.length} teams`);
    return allPlayers;
  }
}
