import { Pool, PoolClient } from 'pg';
import { LeagueRepository, RosterRepository } from './leagues.repository';
import type { UserRepository } from '../auth/auth.repository';
import type { RosterPlayersRepository } from '../rosters/rosters.repository';
import type { DuesRepository } from '../dues/dues.repository';
import type { WaiverPriorityRepository, FaabBudgetRepository } from '../waivers/waivers.repository';
import { parseWaiverSettings } from '../waivers/waivers.model';
import type { EventListenerService } from '../chat/event-listener.service';
import { EventTypes, tryGetEventBus } from '../../shared/events';
import {
  NotFoundException,
  ForbiddenException,
  ConflictException,
  ValidationException,
} from '../../utils/exceptions';
import { runWithLock, LockDomain } from '../../shared/transaction-runner';
import { logger } from '../../config/logger.config';
import { League } from './leagues.model';

/**
 * Check if a user can join a league at the current time.
 * Enforces that league is pre_draft and all drafts are not_started.
 */
async function canJoinLeagueNow(
  client: PoolClient,
  league: League
): Promise<{ eligible: boolean; reason?: string }> {
  // Rule 1: League must be in pre_draft status
  if (league.status !== 'pre_draft') {
    return {
      eligible: false,
      reason: `Cannot join league: league is currently in ${league.status} phase`,
    };
  }

  // Rule 2: All drafts must be not_started
  const draftResult = await client.query(
    `SELECT status FROM drafts WHERE league_id = $1 AND status != 'not_started' LIMIT 1`,
    [league.id]
  );

  if (draftResult.rows.length > 0) {
    const draftStatus = draftResult.rows[0].status;
    return {
      eligible: false,
      reason: `Cannot join league: a draft is ${draftStatus === 'in_progress' ? 'currently in progress' : draftStatus}`,
    };
  }

  // Rule 3: Schedule must not be generated yet (matchups exist = schedule locked)
  const matchupResult = await client.query(
    `SELECT 1 FROM matchups WHERE league_id = $1 LIMIT 1`,
    [league.id]
  );

  if (matchupResult.rows.length > 0) {
    return {
      eligible: false,
      reason: 'Cannot join league: schedule has already been generated',
    };
  }

  return { eligible: true };
}

/**
 * LOCK CONTRACT:
 * - joinLeague() acquires LEAGUE lock (100M + leagueId) via runWithLock — prevents concurrent joins
 * - kickMember() acquires ROSTER lock (200M + targetRosterId) via runWithLock — serializes roster deletion
 *
 * No method holds both LEAGUE and ROSTER locks simultaneously.
 */
export class RosterService {
  constructor(
    private readonly db: Pool,
    private readonly leagueRepo: LeagueRepository,
    private readonly rosterRepo: RosterRepository,
    private readonly userRepo?: UserRepository,
    private readonly rosterPlayersRepo?: RosterPlayersRepository,
    private readonly eventListenerService?: EventListenerService,
    private readonly duesRepo?: DuesRepository,
    private readonly waiverPriorityRepo?: WaiverPriorityRepository,
    private readonly faabBudgetRepo?: FaabBudgetRepository
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

  /**
   * Creates the initial roster with explicit client (for transaction support)
   */
  async createInitialRosterWithClient(
    client: PoolClient,
    leagueId: number,
    userId: string
  ): Promise<{ rosterId: number }> {
    const roster = await this.rosterRepo.create(leagueId, userId, 1, client);
    await this.leagueRepo.updateCommissionerRosterIdWithClient(client, leagueId, roster.rosterId);
    return { rosterId: roster.rosterId };
  }

  async joinLeague(leagueId: number, userId: string, client?: PoolClient): Promise<{ message: string; roster: any; joinedAsBench?: boolean }> {
    // If client is provided, use it directly (caller already has lock)
    // Otherwise, acquire lock and call internal method
    const { roster, joinedAsBench } = client
      ? await this.joinLeagueInternal(client, leagueId, userId)
      : await runWithLock(
          this.db,
          LockDomain.LEAGUE,
          leagueId,
          (c) => this.joinLeagueInternal(c, leagueId, userId)
        );

    // Post-commit operations: domain events and chat messages
    const teamName = `Team ${roster.rosterId}`;
    const eventBus = tryGetEventBus();

    // Emit domain event for real-time UI update
    eventBus?.publish({
      type: EventTypes.MEMBER_JOINED,
      leagueId,
      payload: {
        rosterDbId: roster.id,
        rosterSlotId: roster.rosterId,
        teamName,
        userId,
      },
    });

    // Send system message to league chat (fire-and-forget to not slow down join response)
    if (this.eventListenerService) {
      this.eventListenerService
        .handleMemberJoined(leagueId, teamName)
        .catch((err) =>
          logger.warn('Failed to emit member joined message', {
            leagueId,
            teamName,
            error: err.message,
          })
        );
    }

    // Emit draft order update for any not-started drafts so draft room shows updated team names
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
      eventBus?.publish({
        type: EventTypes.DRAFT_SETTINGS_UPDATED,
        payload: { draftId, draft_order: draftOrder },
      });
    }

    return {
      message: joinedAsBench
        ? 'Successfully joined the league as a bench member'
        : 'Successfully joined the league',
      roster: {
        roster_id: roster.rosterId,
        league_id: roster.leagueId,
      },
      joinedAsBench,
    };
  }

  /**
   * Internal method that performs the actual join logic within a transaction.
   * Used by joinLeague() with or without an explicit lock.
   */
  private async joinLeagueInternal(
    client: PoolClient,
    leagueId: number,
    userId: string
  ): Promise<{ roster: any; joinedAsBench: boolean }> {
    // Fetch league inside the lock with the transaction client for fresh data
    const league = await this.leagueRepo.findById(leagueId, client);
    if (!league) {
      throw new NotFoundException('League not found');
    }

    // Check join eligibility (must be pre_draft with no drafts started)
    const eligibility = await canJoinLeagueNow(client, league);
    if (!eligibility.eligible) {
      throw new ConflictException(eligibility.reason!);
    }

    // Check if already a member (inside transaction)
    const existingRoster = await this.rosterRepo.findByLeagueAndUser(leagueId, userId, client);
    if (existingRoster) {
      throw new ConflictException('You are already a member of this league');
    }

    let roster;
    let joinedAsBench = false;

    // Try to claim an empty roster first (for leagues with pre-created rosters from randomization)
    const emptyRoster = await this.rosterRepo.findEmptyRoster(leagueId, client);
    if (emptyRoster) {
      // Claim the empty roster - preserves their randomized draft position
      roster = await this.rosterRepo.assignUserToRoster(emptyRoster.id, userId, client);
    } else {
      // No empty roster available - check if league is full
      const rosterCount = await this.rosterRepo.getRosterCount(leagueId, client);
      if (rosterCount >= league.totalRosters) {
        // League is at capacity - check if it's a paid league with unpaid members
        const canJoinAsBench = await this.canJoinAsBenchWithClient(client, leagueId, rosterCount);

        if (canJoinAsBench) {
          // Create as benched roster - user can participate once someone pays or leaves
          const nextRosterId = await this.rosterRepo.getNextRosterId(leagueId, client);
          roster = await this.rosterRepo.create(leagueId, userId, nextRosterId, client);
          await this.rosterRepo.benchMember(roster.id, client);
          joinedAsBench = true;
        } else {
          throw new ConflictException('League is full');
        }
      } else {
        // Create new roster (league doesn't have pre-created empty rosters)
        const nextRosterId = await this.rosterRepo.getNextRosterId(leagueId, client);
        roster = await this.rosterRepo.create(leagueId, userId, nextRosterId, client);
      }
    }

    // Initialize waiver rows for late-joining roster
    await this.ensureWaiverRowsForRoster(league, roster.id, client);

    return { roster, joinedAsBench };
  }

  /**
   * Check if a user can join a paid league as bench (when at capacity but not all paid)
   * Returns true if:
   * - League has dues configured
   * - Not all active members have paid their dues
   */
  private async canJoinAsBench(
    leagueId: number,
    activeRosterCount: number,
    client: any
  ): Promise<boolean> {
    return this.canJoinAsBenchWithClient(client, leagueId, activeRosterCount);
  }

  /**
   * Check if a user can join a paid league as bench (with explicit client parameter)
   */
  private async canJoinAsBenchWithClient(
    client: any,
    leagueId: number,
    activeRosterCount: number
  ): Promise<boolean> {
    // Check if league has dues
    const duesResult = await client.query(
      'SELECT id FROM league_dues WHERE league_id = $1',
      [leagueId]
    );

    if (duesResult.rows.length === 0) {
      // Free league - cannot join as bench
      return false;
    }

    // Check how many active members have paid
    const paidResult = await client.query(
      `SELECT COUNT(DISTINCT dp.roster_id) as paid_count
       FROM dues_payments dp
       INNER JOIN rosters r ON dp.roster_id = r.id
       WHERE dp.league_id = $1 AND dp.is_paid = true AND r.is_benched = false`,
      [leagueId]
    );

    const paidCount = Number(paidResult.rows[0].paid_count) || 0;

    // Can join as bench if not all active members have paid
    return paidCount < activeRosterCount;
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

    // Emit domain event (reuse member joined event as the UI effect is similar)
    if (targetRoster.userId) {
      const eventBus = tryGetEventBus();
      eventBus?.publish({
        type: EventTypes.MEMBER_JOINED,
        leagueId,
        payload: {
          rosterDbId: targetRosterId,
          rosterSlotId: targetRoster.rosterId,
          teamName,
          userId: targetRoster.userId,
        },
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

        // Try to claim an empty roster first (preserves draft position)
        const emptyRoster = await this.rosterRepo.findEmptyRoster(leagueId);
        let rosterId: number;

        if (emptyRoster) {
          await this.rosterRepo.assignUserToRoster(emptyRoster.id, user.userId);
          rosterId = emptyRoster.rosterId;
        } else {
          // Check if league is full
          const rosterCount = await this.rosterRepo.getRosterCount(leagueId);
          if (rosterCount >= league.totalRosters) {
            results.push({ username, success: false, error: 'League is full' });
            continue;
          }
          // Create new roster only if no empty slots
          rosterId = await this.rosterRepo.getNextRosterId(leagueId);
          await this.rosterRepo.create(leagueId, user.userId, rosterId);
        }

        // Emit domain event for real-time UI update
        // For devBulkAddUsers, we need to get the roster DB id
        const addedRoster = await this.rosterRepo.findByLeagueAndUser(leagueId, user.userId);
        const eventBus = tryGetEventBus();
        eventBus?.publish({
          type: EventTypes.MEMBER_JOINED,
          leagueId,
          payload: {
            rosterDbId: addedRoster?.id ?? 0,
            rosterSlotId: rosterId,
            teamName: username,
            userId: user.userId,
          },
        });

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

    // Get team name and slot ID before deletion
    const teamName = (await this.rosterRepo.getTeamName(targetRosterId)) || 'Unknown Team';
    const rosterSlotId = targetRoster.rosterId;

    // Use transaction with roster lock to delete everything
    await runWithLock(this.db, LockDomain.ROSTER, targetRosterId, async (client) => {
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
    });

    // Post-commit: Emit domain event
    const eventBus = tryGetEventBus();
    eventBus?.publish({
      type: EventTypes.MEMBER_KICKED,
      leagueId,
      payload: {
        rosterDbId: targetRosterId,
        rosterSlotId,
        teamName,
        userId: targetRoster.userId,
      },
    });

    // Send system message to league chat
    if (this.eventListenerService) {
      await this.eventListenerService.handleMemberKicked(leagueId, teamName);
    }

    return { message: `${teamName} has been removed from the league`, teamName };
  }

  /**
   * Ensure waiver rows (priority + FAAB budget) exist for a roster.
   * Called when a roster joins a league to handle late-joiner initialization.
   */
  private async ensureWaiverRowsForRoster(
    league: { id: number; settings: any; season: string },
    rosterId: number,
    client: PoolClient
  ): Promise<void> {
    const waiverSettings = parseWaiverSettings(league.settings);
    if (waiverSettings.waiverType === 'none') {
      return;
    }

    const season = parseInt(league.season, 10);

    // Ensure priority row exists (assigns last place)
    if (this.waiverPriorityRepo) {
      await this.waiverPriorityRepo.ensureRosterPriority(league.id, rosterId, season, client);
    }

    // Ensure FAAB budget exists if FAAB mode
    if (waiverSettings.waiverType === 'faab' && this.faabBudgetRepo) {
      await this.faabBudgetRepo.ensureRosterBudget(
        league.id,
        rosterId,
        season,
        waiverSettings.faabBudget,
        client
      );
    }
  }
}
