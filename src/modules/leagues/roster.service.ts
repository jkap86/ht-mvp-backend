import { Pool } from 'pg';
import { LeagueRepository, RosterRepository } from './leagues.repository';
import { UserRepository } from '../auth/auth.repository';
import {
  NotFoundException,
  ForbiddenException,
  ConflictException,
  ValidationException,
} from '../../utils/exceptions';

export class RosterService {
  constructor(
    private readonly leagueRepo: LeagueRepository,
    private readonly rosterRepo: RosterRepository,
    private readonly userRepo?: UserRepository,
    private readonly db?: Pool
  ) {}

  /**
   * Creates the initial roster for a league creator (commissioner)
   * Returns the roster and updates the league's commissioner_roster_id
   */
  async createInitialRoster(leagueId: number, userId: string): Promise<{ rosterId: number }> {
    const roster = await this.rosterRepo.create(leagueId, userId, 1);
    await this.leagueRepo.updateCommissionerRosterId(leagueId, roster.rosterId);
    return { rosterId: roster.rosterId };
  }

  async joinLeague(leagueId: number, userId: string): Promise<{ message: string; roster: any }> {
    // Use transaction with advisory lock to prevent race conditions
    if (!this.db) {
      throw new ValidationException('Database pool not available');
    }

    const client = await this.db.connect();
    try {
      await client.query('BEGIN');

      // Acquire advisory lock on the league to prevent concurrent joins
      await client.query('SELECT pg_advisory_xact_lock($1)', [leagueId]);

      // Check if league exists
      const leagueResult = await client.query(
        'SELECT * FROM leagues WHERE id = $1',
        [leagueId]
      );
      if (leagueResult.rows.length === 0) {
        throw new NotFoundException('League not found');
      }
      const league = leagueResult.rows[0];

      // Check if already a member
      const existingResult = await client.query(
        'SELECT * FROM rosters WHERE league_id = $1 AND user_id = $2',
        [leagueId, userId]
      );
      if (existingResult.rows.length > 0) {
        throw new ConflictException('You are already a member of this league');
      }

      // Check if league is full
      const countResult = await client.query(
        'SELECT COUNT(*) as count FROM rosters WHERE league_id = $1',
        [leagueId]
      );
      const rosterCount = parseInt(countResult.rows[0].count, 10);
      if (rosterCount >= league.total_rosters) {
        throw new ConflictException('League is full');
      }

      // Get next roster ID
      const nextIdResult = await client.query(
        'SELECT COALESCE(MAX(roster_id), 0) + 1 as next_id FROM rosters WHERE league_id = $1',
        [leagueId]
      );
      const nextRosterId = nextIdResult.rows[0].next_id;

      // Create roster
      const rosterResult = await client.query(
        `INSERT INTO rosters (league_id, user_id, roster_id)
         VALUES ($1, $2, $3)
         RETURNING *`,
        [leagueId, userId, nextRosterId]
      );

      await client.query('COMMIT');

      const roster = rosterResult.rows[0];
      return {
        message: 'Successfully joined the league',
        roster: {
          roster_id: roster.roster_id,
          league_id: roster.league_id,
        },
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async getLeagueMembers(leagueId: number, userId: string): Promise<any[]> {
    // Check if user is a member
    const isMember = await this.leagueRepo.isUserMember(leagueId, userId);
    if (!isMember) {
      throw new ForbiddenException('You are not a member of this league');
    }

    const rosters = await this.rosterRepo.findByLeagueId(leagueId);

    return rosters.map(r => ({
      id: r.id,
      league_id: r.leagueId,
      user_id: r.userId,
      roster_id: r.rosterId,
      team_name: (r as any).teamName || null,
      username: (r as any).username || 'Unknown',
    }));
  }

  async devBulkAddUsers(
    leagueId: number,
    usernames: string[]
  ): Promise<Array<{ username: string; success: boolean; error?: string }>> {
    if (!this.userRepo) {
      throw new ValidationException('User repository not available');
    }

    const league = await this.leagueRepo.findById(leagueId);
    if (!league) {
      throw new NotFoundException('League not found');
    }

    const results: Array<{ username: string; success: boolean; error?: string }> = [];

    for (const username of usernames) {
      try {
        // Look up user by username
        const user = await this.userRepo.findByUsername(username);
        if (!user) {
          results.push({ username, success: false, error: 'User not found' });
          continue;
        }

        // Check if already a member
        const existingRoster = await this.rosterRepo.findByLeagueAndUser(leagueId, user.userId);
        if (existingRoster) {
          results.push({ username, success: false, error: 'Already a member' });
          continue;
        }

        // Check if league is full
        const rosterCount = await this.rosterRepo.getRosterCount(leagueId);
        if (rosterCount >= league.totalRosters) {
          results.push({ username, success: false, error: 'League is full' });
          continue;
        }

        // Get next roster ID and create roster
        const nextRosterId = await this.rosterRepo.getNextRosterId(leagueId);
        await this.rosterRepo.create(leagueId, user.userId, nextRosterId);

        results.push({ username, success: true });
      } catch (error: any) {
        results.push({ username, success: false, error: error.message || 'Unknown error' });
      }
    }

    return results;
  }
}
