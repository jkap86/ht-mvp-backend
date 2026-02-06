import { Pool } from 'pg';
import { MatchupsRepository } from './matchups.repository';
import { LeagueRepository, RosterRepository } from '../leagues/leagues.repository';
import { NotFoundException, ForbiddenException, ValidationException, ConflictException } from '../../utils/exceptions';

/**
 * Generated matchup data for a single game
 */
export interface GeneratedMatchup {
  week: number;
  roster1Id: number;
  roster2Id: number;
}

/**
 * Schedule generation options
 */
export interface ScheduleGenerationOptions {
  leagueId: number;
  weeks: number;
  userId: string;
}

/**
 * Service responsible for generating league schedules
 * Handles round-robin algorithm and schedule persistence
 */
export class ScheduleGeneratorService {
  constructor(
    private readonly db: Pool,
    private readonly matchupsRepo: MatchupsRepository,
    private readonly rosterRepo: RosterRepository,
    private readonly leagueRepo: LeagueRepository
  ) {}

  /**
   * Generate round-robin schedule for regular season
   */
  async generateSchedule(leagueId: number, weeks: number, userId: string): Promise<void> {
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

    // Check if schedule already exists
    const existingCount = await this.matchupsRepo.countByLeagueSeason(leagueId, season);
    if (existingCount > 0) {
      throw new ConflictException(
        'Schedule already exists for this season. Delete existing schedule first.'
      );
    }

    // Generate round-robin matchups
    const rosterIds = rosters.map((r) => r.id);
    const matchups = this.generateRoundRobinMatchups(rosterIds, weeks);

    // Create matchups in database
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');

      for (const { week, roster1Id, roster2Id } of matchups) {
        await this.matchupsRepo.create(leagueId, season, week, roster1Id, roster2Id, false, client);
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
   * Generate schedule without commissioner check (for system/automated use)
   * Used when draft completes via autopick.
   * Idempotent: silently returns if schedule already exists.
   */
  async generateScheduleSystem(leagueId: number, weeks: number): Promise<void> {
    const league = await this.leagueRepo.findById(leagueId);
    if (!league) {
      throw new NotFoundException('League not found');
    }

    const rosters = await this.rosterRepo.findByLeagueId(leagueId);
    if (rosters.length < 2) {
      throw new ValidationException('Need at least 2 teams to generate schedule');
    }

    const season = parseInt(league.season, 10);

    // Check if schedule already exists (idempotent - skip if exists)
    const existingCount = await this.matchupsRepo.countByLeagueSeason(leagueId, season);
    if (existingCount > 0) {
      return; // Schedule already generated, nothing to do
    }

    // Generate round-robin matchups
    const rosterIds = rosters.map((r) => r.id);
    const matchups = this.generateRoundRobinMatchups(rosterIds, weeks);

    // Create matchups in database
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');

      for (const { week, roster1Id, roster2Id } of matchups) {
        await this.matchupsRepo.create(leagueId, season, week, roster1Id, roster2Id, false, client);
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
  generateRoundRobinMatchups(rosterIds: number[], weeks: number): GeneratedMatchup[] {
    const matchups: GeneratedMatchup[] = [];
    const teams = [...rosterIds];

    // If odd number of teams, add a "bye" placeholder
    if (teams.length % 2 !== 0) {
      teams.push(-1); // -1 represents bye week
    }

    const n = teams.length;
    const roundsNeeded = n - 1; // One full round robin

    for (let week = 1; week <= weeks; week++) {
      // Calculate which round within the round-robin cycle
      const round = (week - 1) % roundsNeeded;

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
   * First team stays fixed, others rotate around
   */
  rotateTeams(teams: number[], round: number): number[] {
    if (teams.length < 2) return teams;

    const result = [...teams];

    // Rotate all except first element
    for (let r = 0; r < round; r++) {
      const last = result.pop()!;
      result.splice(1, 0, last);
    }

    return result;
  }
}
