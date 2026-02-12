import { Pool, PoolClient } from 'pg';
import { RosterPlayersRepository, RosterTransactionsRepository } from './rosters.repository';
import type { RosterRepository, LeagueRepository } from '../leagues/leagues.repository';
import { RosterPlayer, RosterPlayerWithDetails, RosterTransaction } from './rosters.model';
import type { WaiverWireRepository } from '../waivers/waivers.repository';
import { parseWaiverSettings } from '../waivers/waivers.model';
import { RosterMutationService } from './roster-mutation.service';
import { runWithLock, LockDomain } from '../../shared/transaction-runner';
import {
  NotFoundException,
  ForbiddenException,
  ValidationException,
} from '../../utils/exceptions';
import { getMaxRosterSize } from '../../shared/roster-defaults';

/**
 * LOCK CONTRACT:
 * - addPlayer() acquires LEAGUE lock (100M + leagueId) via runWithLock — prevents concurrent free agent claims
 * - dropPlayer() acquires LEAGUE lock (100M + leagueId) via runWithLock — prevents race with waiver claims
 * - addDropPlayer() acquires LEAGUE lock (100M + leagueId) via runWithLock — prevents concurrent free agent claims
 *
 * All methods acquire only LEAGUE lock. No nested cross-domain advisory locks.
 * Note: Uses LEAGUE (not ROSTER) because free agent operations need league-wide exclusion
 * to prevent two rosters from claiming the same player simultaneously.
 */
export class RosterService {
  constructor(
    private readonly db: Pool,
    private readonly rosterPlayersRepo: RosterPlayersRepository,
    private readonly transactionsRepo: RosterTransactionsRepository,
    private readonly rosterRepo: RosterRepository,
    private readonly leagueRepo: LeagueRepository,
    private readonly waiverWireRepo?: WaiverWireRepository,
    private readonly rosterMutationService?: RosterMutationService
  ) {}

  /**
   * Add a player to the waiver wire if the league has waivers enabled
   */
  private async addToWaiverWireIfEnabled(
    league: any,
    playerId: number,
    droppedByRosterId: number,
    client?: PoolClient
  ): Promise<void> {
    if (!this.waiverWireRepo) return;

    const waiverSettings = parseWaiverSettings(league.settings);

    // If waiver type is 'none', don't add to waiver wire
    if (waiverSettings.waiverType === 'none') return;

    // Calculate waiver expiration based on waiver_period_days
    const waiverPeriodDays = waiverSettings.waiverPeriodDays || 2;
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + waiverPeriodDays);

    await this.waiverWireRepo.addPlayer(
      league.id,
      playerId,
      droppedByRosterId,
      expiresAt,
      parseInt(league.season, 10),
      league.currentWeek,
      client
    );
  }

  /**
   * Get all players on a roster
   */
  async getRosterPlayers(
    leagueId: number,
    rosterId: number,
    userId: string
  ): Promise<RosterPlayerWithDetails[]> {
    // Validate league membership
    const isMember = await this.leagueRepo.isUserMember(leagueId, userId);
    if (!isMember) {
      throw new ForbiddenException('You are not a member of this league');
    }

    // Validate roster exists - use findByLeagueAndRosterId since URL contains per-league roster_id
    const roster = await this.rosterRepo.findByLeagueAndRosterId(leagueId, rosterId);
    if (!roster) {
      throw new NotFoundException('Roster not found');
    }

    // Use the global id for roster_players query
    return this.rosterPlayersRepo.getByRosterId(roster.id);
  }

  /**
   * Add a player to roster (free agency)
   */
  async addPlayer(
    leagueId: number,
    rosterId: number,
    playerId: number,
    userId: string
  ): Promise<RosterPlayer> {
    // Validate user owns this roster - use findByLeagueAndRosterId since URL contains per-league roster_id
    const roster = await this.rosterRepo.findByLeagueAndRosterId(leagueId, rosterId);
    if (!roster) {
      throw new NotFoundException('Roster not found');
    }

    if (roster.userId !== userId) {
      throw new ForbiddenException('You can only manage your own roster');
    }

    // Use the global id for all subsequent operations
    const globalRosterId = roster.id;

    // Use runWithLock with league lock to prevent concurrent free agent claims
    return runWithLock(this.db, LockDomain.LEAGUE, leagueId, async (client) => {
      // Get league for transaction recording
      const league = await this.leagueRepo.findById(leagueId);
      if (!league) {
        throw new NotFoundException('League not found');
      }

      // Enforce waivers: cannot add a player who is currently on the waiver wire
      const waiverSettings = parseWaiverSettings(league.settings);
      if (waiverSettings.waiverType !== 'none' && this.waiverWireRepo) {
        const isOnWaivers = await this.waiverWireRepo.isOnWaivers(leagueId, playerId, client, league.activeLeagueSeasonId);
        if (isOnWaivers) {
          throw new ValidationException('Player is on waivers. Submit a waiver claim instead.');
        }
      }

      // Use mutation service for validation and add
      const rosterPlayer = await this.rosterMutationService!.addPlayerToRoster(
        {
          rosterId: globalRosterId,
          playerId,
          leagueId,
          acquiredType: 'free_agent',
        },
        {},
        client
      );

      // Record transaction
      await this.transactionsRepo.create(
        leagueId,
        globalRosterId,
        playerId,
        'add',
        parseInt(league.season, 10),
        league.currentWeek,
        undefined,
        client,
        league.activeLeagueSeasonId
      );

      return rosterPlayer;
    });
  }

  /**
   * Drop a player from roster
   */
  async dropPlayer(
    leagueId: number,
    rosterId: number,
    playerId: number,
    userId: string
  ): Promise<void> {
    // Validate user owns this roster - use findByLeagueAndRosterId since URL contains per-league roster_id
    const roster = await this.rosterRepo.findByLeagueAndRosterId(leagueId, rosterId);
    if (!roster) {
      throw new NotFoundException('Roster not found');
    }

    if (roster.userId !== userId) {
      throw new ForbiddenException('You can only manage your own roster');
    }

    // Use the global id for all subsequent operations
    const globalRosterId = roster.id;

    const league = await this.leagueRepo.findById(leagueId);
    if (!league) {
      throw new NotFoundException('League not found');
    }

    // Use runWithLock with league lock to prevent race with waiver claims
    await runWithLock(this.db, LockDomain.LEAGUE, leagueId, async (client) => {
      // Use mutation service for validation and remove
      await this.rosterMutationService!.removePlayerFromRoster(
        { rosterId: globalRosterId, playerId },
        client
      );

      // Record transaction
      await this.transactionsRepo.create(
        leagueId,
        globalRosterId,
        playerId,
        'drop',
        parseInt(league.season, 10),
        league.currentWeek,
        undefined,
        client,
        league.activeLeagueSeasonId
      );

      // Add to waiver wire if league has waivers enabled
      await this.addToWaiverWireIfEnabled(league, playerId, globalRosterId, client);
    });
  }

  /**
   * Add/drop in a single transaction
   */
  async addDropPlayer(
    leagueId: number,
    rosterId: number,
    addPlayerId: number,
    dropPlayerId: number,
    userId: string
  ): Promise<RosterPlayer> {
    // Validate user owns this roster - use findByLeagueAndRosterId since URL contains per-league roster_id
    const roster = await this.rosterRepo.findByLeagueAndRosterId(leagueId, rosterId);
    if (!roster) {
      throw new NotFoundException('Roster not found');
    }

    if (roster.userId !== userId) {
      throw new ForbiddenException('You can only manage your own roster');
    }

    // Use the global id for all subsequent operations
    const globalRosterId = roster.id;

    // Use runWithLock with league lock to prevent concurrent free agent claims
    return runWithLock(this.db, LockDomain.LEAGUE, leagueId, async (client) => {
      const league = await this.leagueRepo.findById(leagueId);
      if (!league) {
        throw new NotFoundException('League not found');
      }

      // Enforce waivers: cannot add a player who is currently on the waiver wire
      const waiverSettings = parseWaiverSettings(league.settings);
      if (waiverSettings.waiverType !== 'none' && this.waiverWireRepo) {
        const isOnWaivers = await this.waiverWireRepo.isOnWaivers(leagueId, addPlayerId, client, league.activeLeagueSeasonId);
        if (isOnWaivers) {
          throw new ValidationException('Player is on waivers. Submit a waiver claim instead.');
        }
      }

      // Use mutation service for validation and swap
      const rosterPlayer = await this.rosterMutationService!.swapPlayers(
        {
          rosterId: globalRosterId,
          addPlayerId,
          dropPlayerId,
          leagueId,
          acquiredType: 'free_agent',
        },
        client
      );

      // Record both transactions
      const dropTx = await this.transactionsRepo.create(
        leagueId,
        globalRosterId,
        dropPlayerId,
        'drop',
        parseInt(league.season, 10),
        league.currentWeek,
        undefined,
        client,
        league.activeLeagueSeasonId
      );

      await this.transactionsRepo.create(
        leagueId,
        globalRosterId,
        addPlayerId,
        'add',
        parseInt(league.season, 10),
        league.currentWeek,
        dropTx.id,
        client,
        league.activeLeagueSeasonId
      );

      // Add dropped player to waiver wire if league has waivers enabled
      await this.addToWaiverWireIfEnabled(league, dropPlayerId, globalRosterId, client);

      return rosterPlayer;
    });
  }

  /**
   * Get free agents (unowned players)
   */
  async getFreeAgents(
    leagueId: number,
    userId: string,
    position?: string,
    search?: string,
    limit: number = 50,
    offset: number = 0
  ): Promise<any[]> {
    // Validate league membership
    const isMember = await this.leagueRepo.isUserMember(leagueId, userId);
    if (!isMember) {
      throw new ForbiddenException('You are not a member of this league');
    }

    // Get league mode to determine if college players should be included
    const league = await this.leagueRepo.findById(leagueId);
    const leagueMode = league?.mode || 'redraft';

    return this.rosterPlayersRepo.getFreeAgents(leagueId, position, search, limit, offset, leagueMode, league?.activeLeagueSeasonId);
  }

  /**
   * Get recent transactions for a league
   */
  async getLeagueTransactions(
    leagueId: number,
    userId: string,
    limit: number = 50,
    offset: number = 0
  ): Promise<RosterTransaction[]> {
    // Validate league membership
    const [isMember, league] = await Promise.all([
      this.leagueRepo.isUserMember(leagueId, userId),
      this.leagueRepo.findById(leagueId),
    ]);
    if (!isMember) {
      throw new ForbiddenException('You are not a member of this league');
    }

    return this.transactionsRepo.getByLeague(leagueId, limit, offset, league?.activeLeagueSeasonId);
  }

  /**
   * Check if player is owned in league
   */
  async isPlayerOwned(leagueId: number, playerId: number): Promise<number | null> {
    return this.rosterPlayersRepo.findOwner(leagueId, playerId);
  }

  /**
   * Check if roster is at max capacity
   */
  async isRosterFull(rosterId: number, leagueId: number): Promise<boolean> {
    const league = await this.leagueRepo.findById(leagueId);
    if (!league) return true;

    const rosterSize = await this.rosterPlayersRepo.getPlayerCount(rosterId);
    const maxRosterSize = getMaxRosterSize(league.settings);

    return rosterSize >= maxRosterSize;
  }
}
