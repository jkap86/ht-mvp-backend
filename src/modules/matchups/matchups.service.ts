import { Pool } from 'pg';
import { MatchupsRepository } from './matchups.repository';
import { LineupsRepository } from '../lineups/lineups.repository';
import { LeagueRepository, RosterRepository } from '../leagues/leagues.repository';
import { ScoringService } from '../scoring/scoring.service';
import { PlayerStatsRepository } from '../scoring/scoring.repository';
import { ScoringRules, DEFAULT_SCORING_RULES, ScoringType } from '../scoring/scoring.model';
import { PlayerRepository } from '../players/players.repository';
import {
  Matchup,
  MatchupDetails,
  Standing,
  MatchupWithLineups,
  MatchupTeamLineup,
  MatchupPlayerPerformance,
} from './matchups.model';
import { LineupSlots, PositionSlot } from '../lineups/lineups.model';
import {
  NotFoundException,
  ForbiddenException,
  ValidationException,
} from '../../utils/exceptions';

export class MatchupService {
  constructor(
    private readonly db: Pool,
    private readonly matchupsRepo: MatchupsRepository,
    private readonly lineupsRepo: LineupsRepository,
    private readonly rosterRepo: RosterRepository,
    private readonly leagueRepo: LeagueRepository,
    private readonly scoringService: ScoringService,
    private readonly playerRepo: PlayerRepository,
    private readonly statsRepo: PlayerStatsRepository
  ) {}

  /**
   * Generate round-robin schedule for regular season
   */
  async generateSchedule(
    leagueId: number,
    weeks: number,
    userId: string
  ): Promise<void> {
    // Only commissioner can generate schedule
    const isCommissioner = await this.leagueRepo.isCommissioner(leagueId, userId);
    if (!isCommissioner) {
      throw new ForbiddenException('Only the commissioner can generate the schedule');
    }

    const league = await this.leagueRepo.findById(leagueId);
    if (!league) {
      throw new NotFoundException('League not found');
    }

    const rosters = await this.rosterRepo.findByLeagueId(leagueId);
    if (rosters.length < 2) {
      throw new ValidationException('Need at least 2 teams to generate schedule');
    }

    const season = parseInt(league.season, 10);

    // Delete existing schedule for this season
    await this.matchupsRepo.deleteByLeague(leagueId, season);

    // Generate round-robin matchups
    const rosterIds = rosters.map(r => r.id);
    const matchups = this.generateRoundRobinMatchups(rosterIds, weeks);

    // Create matchups in database
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');

      for (const { week, roster1Id, roster2Id } of matchups) {
        await this.matchupsRepo.create(
          leagueId,
          season,
          week,
          roster1Id,
          roster2Id,
          false,
          client
        );
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Generate round-robin matchups for given rosters
   */
  private generateRoundRobinMatchups(
    rosterIds: number[],
    weeks: number
  ): Array<{ week: number; roster1Id: number; roster2Id: number }> {
    const matchups: Array<{ week: number; roster1Id: number; roster2Id: number }> = [];
    const teams = [...rosterIds];

    // If odd number of teams, add a "bye" placeholder
    if (teams.length % 2 !== 0) {
      teams.push(-1); // -1 represents bye week
    }

    const n = teams.length;
    const roundsNeeded = n - 1; // One full round robin

    for (let week = 1; week <= weeks; week++) {
      // Calculate which round within the round-robin cycle
      const round = ((week - 1) % roundsNeeded);

      // Generate pairings for this round using circle method
      const rotatedTeams = this.rotateTeams(teams, round);

      for (let i = 0; i < n / 2; i++) {
        const team1 = rotatedTeams[i];
        const team2 = rotatedTeams[n - 1 - i];

        // Skip bye matchups
        if (team1 === -1 || team2 === -1) continue;

        // Alternate home/away based on week
        if (week % 2 === 0) {
          matchups.push({ week, roster1Id: team2, roster2Id: team1 });
        } else {
          matchups.push({ week, roster1Id: team1, roster2Id: team2 });
        }
      }
    }

    return matchups;
  }

  /**
   * Rotate teams for round-robin (circle method)
   */
  private rotateTeams(teams: number[], round: number): number[] {
    if (teams.length < 2) return teams;

    const result = [...teams];
    const first = result[0];

    // Rotate all except first element
    for (let r = 0; r < round; r++) {
      const last = result.pop()!;
      result.splice(1, 0, last);
    }

    return result;
  }

  /**
   * Get matchups for a week
   */
  async getWeekMatchups(
    leagueId: number,
    week: number,
    userId: string
  ): Promise<MatchupDetails[]> {
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
    return this.matchupsRepo.findByLeagueAndWeekWithDetails(leagueId, season, week);
  }

  /**
   * Get a single matchup with full details
   */
  async getMatchup(
    matchupId: number,
    userId: string
  ): Promise<MatchupDetails | null> {
    const matchup = await this.matchupsRepo.findById(matchupId);
    if (!matchup) return null;

    // Validate league membership
    const isMember = await this.leagueRepo.isUserMember(matchup.leagueId, userId);
    if (!isMember) {
      throw new ForbiddenException('You are not a member of this league');
    }

    const matchups = await this.matchupsRepo.findByLeagueAndWeekWithDetails(
      matchup.leagueId,
      matchup.season,
      matchup.week
    );

    return matchups.find(m => m.id === matchupId) || null;
  }

  /**
   * Get a matchup with full lineup details for both teams
   */
  async getMatchupWithLineups(
    matchupId: number,
    userId: string
  ): Promise<MatchupWithLineups | null> {
    // Get basic matchup details first
    const matchupDetails = await this.getMatchup(matchupId, userId);
    if (!matchupDetails) return null;

    // Get lineups for both rosters
    const [lineup1, lineup2] = await Promise.all([
      this.lineupsRepo.findByRosterAndWeek(
        matchupDetails.roster1Id,
        matchupDetails.season,
        matchupDetails.week
      ),
      this.lineupsRepo.findByRosterAndWeek(
        matchupDetails.roster2Id,
        matchupDetails.season,
        matchupDetails.week
      ),
    ]);

    // Build team lineups
    const team1 = await this.buildTeamLineup(
      matchupDetails.roster1Id,
      matchupDetails.roster1TeamName,
      lineup1?.lineup,
      matchupDetails.season,
      matchupDetails.week,
      matchupDetails.roster1Points
    );

    const team2 = await this.buildTeamLineup(
      matchupDetails.roster2Id,
      matchupDetails.roster2TeamName,
      lineup2?.lineup,
      matchupDetails.season,
      matchupDetails.week,
      matchupDetails.roster2Points
    );

    return {
      ...matchupDetails,
      team1,
      team2,
    };
  }

  /**
   * Build team lineup with player details and points
   */
  private async buildTeamLineup(
    rosterId: number,
    teamName: string,
    lineup: LineupSlots | undefined,
    season: number,
    week: number,
    totalPoints: number | null
  ): Promise<MatchupTeamLineup> {
    if (!lineup) {
      return {
        rosterId,
        teamName,
        totalPoints: totalPoints ?? 0,
        players: [],
      };
    }

    // Collect all player IDs
    const allPlayerIds: number[] = [];
    const starterSlots: PositionSlot[] = ['QB', 'RB', 'WR', 'TE', 'FLEX', 'K', 'DEF'];

    for (const slot of starterSlots) {
      allPlayerIds.push(...(lineup[slot] || []));
    }
    allPlayerIds.push(...(lineup.BN || []));

    if (allPlayerIds.length === 0) {
      return {
        rosterId,
        teamName,
        totalPoints: totalPoints ?? 0,
        players: [],
      };
    }

    // Fetch players and stats in parallel
    const [players, stats] = await Promise.all([
      this.playerRepo.findByIds(allPlayerIds),
      this.statsRepo.findByPlayersAndWeek(allPlayerIds, season, week),
    ]);

    // Create maps for lookup
    const playerMap = new Map(players.map(p => [p.id, p]));
    const statsMap = new Map(stats.map(s => [s.playerId, s]));

    // Get scoring rules for this league
    const roster = await this.rosterRepo.findById(rosterId);
    const league = roster ? await this.leagueRepo.findById(roster.leagueId) : null;
    const scoringType: ScoringType = league?.scoringSettings?.type || 'ppr';
    const customRules = league?.scoringSettings?.rules;
    const scoringRules: ScoringRules = customRules
      ? { ...DEFAULT_SCORING_RULES[scoringType], ...customRules }
      : DEFAULT_SCORING_RULES[scoringType];

    // Build player performance list
    const performances: MatchupPlayerPerformance[] = [];

    // Process starters
    for (const slot of starterSlots) {
      const playerIds = lineup[slot] || [];
      for (const playerId of playerIds) {
        const player = playerMap.get(playerId);
        const playerStats = statsMap.get(playerId);
        const points = playerStats
          ? this.scoringService.calculatePlayerPoints(playerStats, scoringRules)
          : 0;

        performances.push({
          playerId,
          fullName: player?.fullName || 'Unknown Player',
          position: player?.position || '',
          team: player?.team || null,
          slot,
          points,
          isStarter: true,
        });
      }
    }

    // Process bench
    const benchIds = lineup.BN || [];
    for (const playerId of benchIds) {
      const player = playerMap.get(playerId);
      const playerStats = statsMap.get(playerId);
      const points = playerStats
        ? this.scoringService.calculatePlayerPoints(playerStats, scoringRules)
        : 0;

      performances.push({
        playerId,
        fullName: player?.fullName || 'Unknown Player',
        position: player?.position || '',
        team: player?.team || null,
        slot: 'BN',
        points,
        isStarter: false,
      });
    }

    return {
      rosterId,
      teamName,
      totalPoints: totalPoints ?? 0,
      players: performances,
    };
  }

  /**
   * Calculate and finalize matchup results for a week
   */
  async finalizeWeekMatchups(
    leagueId: number,
    week: number,
    userId: string
  ): Promise<void> {
    // Only commissioner can finalize matchups
    const isCommissioner = await this.leagueRepo.isCommissioner(leagueId, userId);
    if (!isCommissioner) {
      throw new ForbiddenException('Only the commissioner can finalize matchups');
    }

    const league = await this.leagueRepo.findById(leagueId);
    if (!league) {
      throw new NotFoundException('League not found');
    }

    const season = parseInt(league.season, 10);

    // First calculate all scores
    await this.scoringService.calculateWeeklyScores(leagueId, week, userId);

    // Get all matchups for the week
    const matchups = await this.matchupsRepo.findByLeagueAndWeek(leagueId, season, week);

    // Get all lineups for the week
    const lineups = await this.lineupsRepo.getByLeagueAndWeek(leagueId, season, week);
    const lineupMap = new Map(lineups.map(l => [l.rosterId, l]));

    // Update matchup scores and finalize
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');

      for (const matchup of matchups) {
        const lineup1 = lineupMap.get(matchup.roster1Id);
        const lineup2 = lineupMap.get(matchup.roster2Id);

        const roster1Points = lineup1?.totalPoints || 0;
        const roster2Points = lineup2?.totalPoints || 0;

        await this.matchupsRepo.updatePoints(
          matchup.id,
          roster1Points,
          roster2Points,
          client
        );

        await this.matchupsRepo.finalize(matchup.id, client);
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Get current standings
   */
  async getStandings(
    leagueId: number,
    userId: string
  ): Promise<Standing[]> {
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
    const matchupsByRoster = new Map<number, Matchup[]>();
    for (const matchup of allMatchups) {
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

    // Calculate streaks from the grouped data (no additional queries)
    for (const standing of standings) {
      const rosterMatchups = matchupsByRoster.get(standing.rosterId) || [];
      standing.streak = this.calculateStreakFromMatchups(rosterMatchups, standing.rosterId);
    }

    return standings;
  }

  /**
   * Calculate win/loss streak for a roster (legacy method - uses individual query)
   * @deprecated Use calculateStreakFromMatchups for batch processing
   */
  private async calculateStreak(rosterId: number, season: number): Promise<string> {
    const matchups = await this.matchupsRepo.getFinalizedByRoster(rosterId, season);
    return this.calculateStreakFromMatchups(matchups, rosterId);
  }

  /**
   * Calculate win/loss streak from pre-loaded matchups (no database query)
   */
  private calculateStreakFromMatchups(matchups: Matchup[], rosterId: number): string {
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
}
