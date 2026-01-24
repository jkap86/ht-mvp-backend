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
    private readonly db: Pool,
    private readonly leagueRepo: LeagueRepository,
    private readonly rosterRepo: RosterRepository,
    private readonly userRepo?: UserRepository
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
    const league = await this.leagueRepo.findById(leagueId);

    if (!league) {
      throw new NotFoundException('League not found');
    }

    // Use transaction with advisory lock to prevent exceeding roster limits
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      // Advisory lock on league to prevent concurrent joins
      await client.query('SELECT pg_advisory_xact_lock($1)', [leagueId]);

      // Check if already a member (inside transaction)
      const existingRoster = await this.rosterRepo.findByLeagueAndUser(leagueId, userId, client);
      if (existingRoster) {
        throw new ConflictException('You are already a member of this league');
      }

      // Check if league is full (inside transaction)
      const rosterCount = await this.rosterRepo.getRosterCount(leagueId, client);
      if (rosterCount >= league.totalRosters) {
        throw new ConflictException('League is full');
      }

      // Get next roster ID (inside transaction)
      const nextRosterId = await this.rosterRepo.getNextRosterId(leagueId, client);

      // Create roster (inside transaction)
      const roster = await this.rosterRepo.create(leagueId, userId, nextRosterId, client);

      await client.query('COMMIT');

      return {
        message: 'Successfully joined the league',
        roster: {
          roster_id: roster.rosterId,
          league_id: roster.leagueId,
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
