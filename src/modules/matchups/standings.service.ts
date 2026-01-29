import { MatchupsRepository } from './matchups.repository';
import { LeagueRepository } from '../leagues/leagues.repository';
import { Matchup, Standing } from './matchups.model';
import { NotFoundException, ForbiddenException } from '../../utils/exceptions';

/**
 * Streak result for a team
 */
export interface StreakResult {
  type: 'W' | 'L' | 'T';
  count: number;
  formatted: string;
}

/**
 * Service responsible for calculating standings and tiebreakers
 * Handles win/loss records, streaks, and ranking logic
 */
export class StandingsService {
  constructor(
    private readonly matchupsRepo: MatchupsRepository,
    private readonly leagueRepo: LeagueRepository
  ) {}

  /**
   * Get current standings for a league
   */
  async getStandings(leagueId: number, userId: string): Promise<Standing[]> {
    // Validate league membership
    const isMember = await this.leagueRepo.isUserMember(leagueId, userId);
    if (!isMember) {
      throw new ForbiddenException('You are not a member of this league');
    }

    const league = await this.leagueRepo.findById(leagueId);
    if (!league) {
      throw new NotFoundException('League not found');
    }

    const season = parseInt(league.season, 10);
    const standings = await this.matchupsRepo.getStandings(leagueId, season);

    // Batch load all finalized matchups for the league in one query
    const allMatchups = await this.matchupsRepo.getFinalizedByLeague(leagueId, season);

    // Group matchups by roster for efficient streak calculation
    const matchupsByRoster = this.groupMatchupsByRoster(allMatchups);

    // Calculate streaks from the grouped data (no additional queries)
    for (const standing of standings) {
      const rosterMatchups = matchupsByRoster.get(standing.rosterId) || [];
      standing.streak = this.calculateStreakFromMatchups(rosterMatchups, standing.rosterId);
    }

    return standings;
  }

  /**
   * Group matchups by roster ID for efficient processing
   */
  groupMatchupsByRoster(matchups: Matchup[]): Map<number, Matchup[]> {
    const matchupsByRoster = new Map<number, Matchup[]>();

    for (const matchup of matchups) {
      // Add to roster1's list
      if (!matchupsByRoster.has(matchup.roster1Id)) {
        matchupsByRoster.set(matchup.roster1Id, []);
      }
      matchupsByRoster.get(matchup.roster1Id)!.push(matchup);

      // Add to roster2's list
      if (!matchupsByRoster.has(matchup.roster2Id)) {
        matchupsByRoster.set(matchup.roster2Id, []);
      }
      matchupsByRoster.get(matchup.roster2Id)!.push(matchup);
    }

    return matchupsByRoster;
  }

  /**
   * Calculate win/loss streak for a roster (legacy method - uses individual query)
   * @deprecated Use calculateStreakFromMatchups for batch processing
   */
  async calculateStreak(rosterId: number, season: number): Promise<string> {
    const matchups = await this.matchupsRepo.getFinalizedByRoster(rosterId, season);
    return this.calculateStreakFromMatchups(matchups, rosterId);
  }

  /**
   * Calculate win/loss streak from pre-loaded matchups (no database query)
   */
  calculateStreakFromMatchups(matchups: Matchup[], rosterId: number): string {
    if (matchups.length === 0) return '';

    // Sort by week to ensure proper order
    const sortedMatchups = [...matchups].sort((a, b) => a.week - b.week);

    // Get recent results, most recent first
    const recentMatchups = sortedMatchups.slice(-5).reverse();

    let streak = 0;
    let streakType: 'W' | 'L' | 'T' | null = null;

    for (const matchup of recentMatchups) {
      const isRoster1 = matchup.roster1Id === rosterId;
      const myPoints = isRoster1 ? matchup.roster1Points : matchup.roster2Points;
      const oppPoints = isRoster1 ? matchup.roster2Points : matchup.roster1Points;

      if (myPoints === null || oppPoints === null) continue;

      let result: 'W' | 'L' | 'T';
      if (myPoints > oppPoints) {
        result = 'W';
      } else if (myPoints < oppPoints) {
        result = 'L';
      } else {
        result = 'T';
      }

      if (streakType === null) {
        streakType = result;
        streak = 1;
      } else if (result === streakType) {
        streak++;
      } else {
        break;
      }
    }

    if (streakType === null || streak === 0) return '';
    return `${streakType}${streak}`;
  }

  /**
   * Parse a streak string into structured data
   */
  parseStreak(streakStr: string): StreakResult | null {
    if (!streakStr || streakStr.length < 2) return null;

    const type = streakStr[0] as 'W' | 'L' | 'T';
    const count = parseInt(streakStr.slice(1), 10);

    if (!['W', 'L', 'T'].includes(type) || isNaN(count)) {
      return null;
    }

    return {
      type,
      count,
      formatted: streakStr,
    };
  }

  /**
   * Determine matchup result for a roster
   */
  getMatchupResult(matchup: Matchup, rosterId: number): 'W' | 'L' | 'T' | null {
    const isRoster1 = matchup.roster1Id === rosterId;
    const myPoints = isRoster1 ? matchup.roster1Points : matchup.roster2Points;
    const oppPoints = isRoster1 ? matchup.roster2Points : matchup.roster1Points;

    if (myPoints === null || oppPoints === null) return null;

    if (myPoints > oppPoints) return 'W';
    if (myPoints < oppPoints) return 'L';
    return 'T';
  }

  /**
   * Apply tiebreaker logic to standings
   * Default tiebreaker: Points For (already applied in SQL query)
   * Additional tiebreakers could include:
   * - Head-to-head record
   * - Division record
   * - Points against
   */
  applyTiebreakers(standings: Standing[]): Standing[] {
    // Currently sorted by wins DESC, points_for DESC from repository
    // Additional tiebreaker logic can be added here if needed
    return standings;
  }

  /**
   * Get head-to-head record between two rosters
   */
  async getHeadToHeadRecord(
    rosterId1: number,
    rosterId2: number,
    season: number
  ): Promise<{ roster1Wins: number; roster2Wins: number; ties: number }> {
    const matchups = await this.matchupsRepo.getFinalizedByRoster(rosterId1, season);

    let roster1Wins = 0;
    let roster2Wins = 0;
    let ties = 0;

    for (const matchup of matchups) {
      // Check if this matchup is between the two rosters
      const isRelevant =
        (matchup.roster1Id === rosterId1 && matchup.roster2Id === rosterId2) ||
        (matchup.roster1Id === rosterId2 && matchup.roster2Id === rosterId1);

      if (!isRelevant) continue;

      const result = this.getMatchupResult(matchup, rosterId1);
      if (result === 'W') roster1Wins++;
      else if (result === 'L') roster2Wins++;
      else if (result === 'T') ties++;
    }

    return { roster1Wins, roster2Wins, ties };
  }
}
