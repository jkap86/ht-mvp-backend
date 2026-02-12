import { Pool } from 'pg';
import { MatchupsRepository } from './matchups.repository';
import type { LeagueRepository, RosterRepository } from '../leagues/leagues.repository';
import { NotFoundException, ForbiddenException, ValidationException, ConflictException } from '../../utils/exceptions';
import { runInTransaction } from '../../shared/transaction-runner';

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

    if (weeks < 1 || weeks > 18) {
      throw new ValidationException('Schedule weeks must be between 1 and 18');
    }

    const league = await this.leagueRepo.findById(leagueId);
    if (!league) {
      throw new NotFoundException('League not found');
    }

    const rosters = await this.rosterRepo.findByLeagueId(leagueId);
    if (rosters.length < 2) {
      throw new ValidationException('Need at least 2 teams to generate schedule');
    }

    const season = Number(league.season) || 0;
    if (!season) {
      throw new ValidationException('Invalid league season');
    }

    // Generate round-robin matchups
    const rosterIds = rosters.map((r) => r.id);
    const matchups = this.generateRoundRobinMatchups(rosterIds, weeks);

    // Check existence and create matchups atomically within a transaction
    // to prevent duplicate schedules from concurrent requests
    await runInTransaction(this.db, async (client) => {
      // Check inside transaction for atomicity
      const existingResult = await client.query(
        'SELECT COUNT(*) as count FROM matchups WHERE league_id = $1 AND season = $2 AND is_playoff = false',
        [leagueId, season]
      );
      if ((Number(existingResult.rows[0].count) || 0) > 0) {
        throw new ConflictException(
          'Schedule already exists for this season. Delete existing schedule first.'
        );
      }

      for (const { week, roster1Id, roster2Id } of matchups) {
        await this.matchupsRepo.create(leagueId, season, week, roster1Id, roster2Id, false, client);
      }
    });
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

    if (weeks < 1 || weeks > 18) {
      throw new ValidationException('Schedule weeks must be between 1 and 18');
    }

    const rosters = await this.rosterRepo.findByLeagueId(leagueId);
    if (rosters.length < 2) {
      throw new ValidationException('Need at least 2 teams to generate schedule');
    }

    const season = Number(league.season) || 0;
    if (!season) {
      throw new ValidationException('Invalid league season');
    }

    // Generate round-robin matchups
    const rosterIds = rosters.map((r) => r.id);
    const matchups = this.generateRoundRobinMatchups(rosterIds, weeks);

    // Check existence and create matchups atomically within a transaction
    // to prevent duplicate schedules from concurrent draft completions
    await runInTransaction(this.db, async (client) => {
      // Check inside transaction for atomicity
      const existingResult = await client.query(
        'SELECT COUNT(*) as count FROM matchups WHERE league_id = $1 AND season = $2 AND is_playoff = false',
        [leagueId, season]
      );
      if ((Number(existingResult.rows[0].count) || 0) > 0) {
        return; // Schedule already exists
      }

      for (const { week, roster1Id, roster2Id } of matchups) {
        await this.matchupsRepo.create(leagueId, season, week, roster1Id, roster2Id, false, client);
      }
    });
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

        // Canonical order for dedup logic (smaller ID first)
        const [lowId, highId] = team1 < team2 ? [team1, team2] : [team2, team1];
        // Alternate home/away based on round parity to prevent systematic bias
        const [homeId, awayId] = round % 2 === 0 ? [lowId, highId] : [highId, lowId];
        matchups.push({ week, roster1Id: homeId, roster2Id: awayId });
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
