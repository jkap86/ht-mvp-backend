import { Pool } from 'pg';
import { LeagueRepository, RosterRepository } from './leagues.repository';
import { UserRepository } from '../auth/auth.repository';
import { RosterPlayersRepository } from '../rosters/rosters.repository';
import { EventListenerService } from '../chat/event-listener.service';
import { tryGetSocketService } from '../../socket/socket.service';
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
    private readonly userRepo?: UserRepository,
    private readonly rosterPlayersRepo?: RosterPlayersRepository,
    private readonly eventListenerService?: EventListenerService
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

      let roster;

      // Try to claim an empty roster first (for leagues with pre-created rosters from randomization)
      const emptyRoster = await this.rosterRepo.findEmptyRoster(leagueId, client);
      if (emptyRoster) {
        // Claim the empty roster - preserves their randomized draft position
        roster = await this.rosterRepo.assignUserToRoster(emptyRoster.id, userId, client);
      } else {
        // No empty roster available - check if league is full
        const rosterCount = await this.rosterRepo.getRosterCount(leagueId, client);
        if (rosterCount >= league.totalRosters) {
          throw new ConflictException('League is full');
        }

        // Create new roster (league doesn't have pre-created empty rosters)
        const nextRosterId = await this.rosterRepo.getNextRosterId(leagueId, client);
        roster = await this.rosterRepo.create(leagueId, userId, nextRosterId, client);
      }

      await client.query('COMMIT');

      // Get team name for notifications
      const teamName = `Team ${roster.rosterId}`;

      // Emit socket event for real-time UI update
      const socketService = tryGetSocketService();
      socketService?.emitMemberJoined(leagueId, {
        rosterId: roster.rosterId,
        teamName,
        userId,
      });

      // Send system message to league chat
      if (this.eventListenerService) {
        await this.eventListenerService.handleMemberJoined(leagueId, teamName);
      }

      // Emit draft order update for any not-started drafts so draft room shows updated team names
      if (socketService) {
        const draftsResult = await this.db.query(
          `SELECT d.id, dord.draft_position, dord.roster_id,
                  COALESCE(r.settings->>'team_name', u.username, 'Team ' || r.roster_id) as username,
                  r.user_id
           FROM drafts d
           JOIN draft_order dord ON d.id = dord.draft_id
           LEFT JOIN rosters r ON dord.roster_id = r.id
           LEFT JOIN users u ON r.user_id = u.id
           WHERE d.league_id = $1 AND d.status = 'not_started'
           ORDER BY d.id, dord.draft_position`,
          [leagueId]
        );

        // Group by draft and emit settings update for each
        const draftOrders = new Map<number, any[]>();
        for (const row of draftsResult.rows) {
          if (!draftOrders.has(row.id)) {
            draftOrders.set(row.id, []);
          }
          draftOrders.get(row.id)!.push({
            draftPosition: row.draft_position,
            rosterId: row.roster_id,
            username: row.username,
            userId: row.user_id,
          });
        }

        for (const [draftId, draftOrder] of draftOrders) {
          socketService.emitDraftSettingsUpdated(draftId, { draft_order: draftOrder });
        }
      }

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
    // Get all rosters AND check membership in one query to avoid race condition
    const rosters = await this.rosterRepo.findByLeagueIdWithMembershipCheck(leagueId, userId);

    // findByLeagueIdWithMembershipCheck returns null if user is not a member
    if (rosters === null) {
      throw new ForbiddenException('You are not a member of this league');
    }

    return rosters.map((r) => ({
      id: r.id,
      league_id: r.leagueId,
      user_id: r.userId,
      roster_id: r.rosterId,
      team_name: (r as any).teamName || null,
      username: r.username || 'Unknown',
      is_benched: r.isBenched || false,
    }));
  }

  /**
   * Reinstate a benched member (commissioner only)
   */
  async reinstateMember(
    leagueId: number,
    targetRosterId: number,
    userId: string
  ): Promise<{ message: string; teamName: string }> {
    // Check if user is commissioner
    const isCommissioner = await this.leagueRepo.isCommissioner(leagueId, userId);
    if (!isCommissioner) {
      throw new ForbiddenException('Only the commissioner can reinstate members');
    }

    // Get target roster
    const targetRoster = await this.rosterRepo.findById(targetRosterId);
    if (!targetRoster) {
      throw new NotFoundException('Roster not found');
    }

    // Verify roster belongs to this league
    if (targetRoster.leagueId !== leagueId) {
      throw new ValidationException('Roster does not belong to this league');
    }

    // Verify roster is actually benched
    if (!targetRoster.isBenched) {
      throw new ValidationException('This member is not benched');
    }

    // Get league to check capacity
    const league = await this.leagueRepo.findById(leagueId);
    if (!league) {
      throw new NotFoundException('League not found');
    }

    // Check if there's room (active count < total_rosters)
    const activeCount = await this.rosterRepo.getRosterCount(leagueId);
    if (activeCount >= league.totalRosters) {
      throw new ValidationException(
        'Cannot reinstate member: league is full. Increase team count or kick an active member first.'
      );
    }

    // Get team name
    const teamName = (await this.rosterRepo.getTeamName(targetRosterId)) || 'Unknown Team';

    // Reinstate the member
    await this.rosterRepo.reinstateMember(targetRosterId);

    // Emit socket event (reuse member joined event as the UI effect is similar)
    const socketService = tryGetSocketService();
    if (socketService && targetRoster.userId) {
      socketService.emitMemberJoined(leagueId, {
        rosterId: targetRosterId,
        teamName,
        userId: targetRoster.userId,
      });
    }

    return { message: `${teamName} has been reinstated`, teamName };
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

  /**
   * Kick a member from the league (commissioner only)
   * Removes their roster and releases all their players
   */
  async kickMember(
    leagueId: number,
    targetRosterId: number,
    userId: string
  ): Promise<{ message: string; teamName: string }> {
    // Check if user is commissioner
    const isCommissioner = await this.leagueRepo.isCommissioner(leagueId, userId);
    if (!isCommissioner) {
      throw new ForbiddenException('Only the commissioner can kick members');
    }

    // Get target roster
    const targetRoster = await this.rosterRepo.findById(targetRosterId);
    if (!targetRoster) {
      throw new NotFoundException('Roster not found');
    }

    // Verify roster belongs to this league
    if (targetRoster.leagueId !== leagueId) {
      throw new ValidationException('Roster does not belong to this league');
    }

    // Get commissioner's roster to prevent self-kick
    const commissionerRoster = await this.rosterRepo.findByLeagueAndUser(leagueId, userId);
    if (commissionerRoster && commissionerRoster.id === targetRosterId) {
      throw new ValidationException('Cannot kick yourself from the league');
    }

    // Get team name before deletion
    const teamName = (await this.rosterRepo.getTeamName(targetRosterId)) || 'Unknown Team';

    // Use transaction to delete everything
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      // Advisory lock on roster to prevent race conditions
      await client.query('SELECT pg_advisory_xact_lock($1)', [targetRosterId + 1000000]);

      // Delete roster players (release all players)
      if (this.rosterPlayersRepo) {
        await this.rosterPlayersRepo.deleteAllByRosterId(targetRosterId, client);
      } else {
        await client.query('DELETE FROM roster_players WHERE roster_id = $1', [targetRosterId]);
      }

      // Delete roster lineups
      await client.query('DELETE FROM roster_lineups WHERE roster_id = $1', [targetRosterId]);

      // Cancel pending trades involving this roster
      await client.query(
        `UPDATE trades SET status = 'cancelled'
         WHERE (proposer_roster_id = $1 OR recipient_roster_id = $1)
           AND status IN ('pending', 'in_review')`,
        [targetRosterId]
      );

      // Cancel pending waiver claims
      await client.query(
        `UPDATE waiver_claims SET status = 'cancelled'
         WHERE roster_id = $1 AND status = 'pending'`,
        [targetRosterId]
      );

      // Delete waiver priority entry
      await client.query('DELETE FROM waiver_priority WHERE roster_id = $1', [targetRosterId]);

      // Delete FAAB budget entry
      await client.query('DELETE FROM faab_budgets WHERE roster_id = $1', [targetRosterId]);

      // Delete the roster itself
      await this.rosterRepo.delete(targetRosterId, client);

      await client.query('COMMIT');

      // Emit socket event
      const socketService = tryGetSocketService();
      socketService?.emitMemberKicked(leagueId, { rosterId: targetRosterId, teamName });

      // Send system message to league chat
      if (this.eventListenerService) {
        await this.eventListenerService.handleMemberKicked(leagueId, teamName);
      }

      return { message: `${teamName} has been removed from the league`, teamName };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
