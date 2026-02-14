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
import { League, Roster } from '../leagues/leagues.model';
import { playerFromDatabase, Player } from '../players/players.model';
import type { EventListenerService } from '../chat/event-listener.service';
import type { PlayerRepository } from '../players/players.repository';
import { EventTypes, tryGetEventBus } from '../../shared/events';
import { logger } from '../../config/logger.config';

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
    private readonly waiverWireRepo: WaiverWireRepository,
    private readonly rosterMutationService: RosterMutationService,
    private readonly eventListenerService?: EventListenerService,
    private readonly playerRepo?: PlayerRepository
  ) {}

  /**
   * Add a player to the waiver wire if the league has waivers enabled
   */
  private async addToWaiverWireIfEnabled(
    league: League,
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
   * Emit socket events and system messages for FA operations.
   * Fire-and-forget — never breaks the FA operation.
   * Called AFTER transaction commits (per gotchas.md).
   */
  private emitFaEvents(
    leagueId: number,
    roster: Roster,
    action: 'add' | 'drop' | 'add_drop',
    addPlayerId?: number,
    dropPlayerId?: number
  ): void {
    if (!this.playerRepo) return;

    const teamName = roster.settings?.team_name || `Team ${roster.rosterId}`;

    // Fire-and-forget
    (async () => {
      const eventBus = tryGetEventBus();

      if (action === 'add' && addPlayerId) {
        const player = await this.playerRepo!.findById(addPlayerId);
        if (!player) return;
        eventBus?.publish({
          type: EventTypes.PLAYER_ADDED,
          leagueId,
          payload: { rosterId: roster.id, playerId: addPlayerId, playerName: player.fullName, position: player.position, team: player.team },
        });
        await this.eventListenerService?.handleFreeAgentAdd(
          leagueId, teamName, player.fullName, addPlayerId, player.position || 'N/A', player.team || 'FA'
        );
      } else if (action === 'drop' && dropPlayerId) {
        const player = await this.playerRepo!.findById(dropPlayerId);
        if (!player) return;
        eventBus?.publish({
          type: EventTypes.PLAYER_DROPPED,
          leagueId,
          payload: { rosterId: roster.id, playerId: dropPlayerId, playerName: player.fullName, position: player.position, team: player.team },
        });
        await this.eventListenerService?.handleFreeAgentDrop(
          leagueId, teamName, player.fullName, dropPlayerId, player.position || 'N/A', player.team || 'FA'
        );
      } else if (action === 'add_drop' && addPlayerId && dropPlayerId) {
        const [addPlayer, dropPlayer] = await Promise.all([
          this.playerRepo!.findById(addPlayerId),
          this.playerRepo!.findById(dropPlayerId),
        ]);
        if (!addPlayer || !dropPlayer) return;
        eventBus?.publish({
          type: EventTypes.PLAYER_ADDED,
          leagueId,
          payload: { rosterId: roster.id, playerId: addPlayerId, playerName: addPlayer.fullName, position: addPlayer.position, team: addPlayer.team },
        });
        eventBus?.publish({
          type: EventTypes.PLAYER_DROPPED,
          leagueId,
          payload: { rosterId: roster.id, playerId: dropPlayerId, playerName: dropPlayer.fullName, position: dropPlayer.position, team: dropPlayer.team },
        });
        await this.eventListenerService?.handleFreeAgentAddDrop(
          leagueId, teamName,
          addPlayer.fullName, addPlayerId, addPlayer.position || 'N/A', addPlayer.team || 'FA',
          dropPlayer.fullName, dropPlayerId, dropPlayer.position || 'N/A', dropPlayer.team || 'FA'
        );
      }
    })().catch((err) => {
      logger.warn('Failed to emit FA events', { error: err instanceof Error ? err.message : String(err), leagueId, action });
    });
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
    userId: string,
    idempotencyKey?: string
  ): Promise<{ rosterPlayer: RosterPlayer; cached: boolean }> {
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

    // Fast-path idempotency check (before lock)
    if (idempotencyKey) {
      const existing = await this.transactionsRepo.findByIdempotencyKey(leagueId, globalRosterId, idempotencyKey);
      if (existing) {
        const rosterPlayer = await this.rosterPlayersRepo.findByRosterAndPlayer(globalRosterId, playerId);
        if (rosterPlayer) return { rosterPlayer, cached: true };
      }
    }

    // Use runWithLock with league lock to prevent concurrent free agent claims
    const rosterPlayer = await runWithLock(this.db, LockDomain.LEAGUE, leagueId, async (client) => {
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
      const rp = await this.rosterMutationService.addPlayerToRoster(
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
        league.activeLeagueSeasonId,
        idempotencyKey
      );

      return rp;
    });

    // Emit events AFTER transaction commits
    this.emitFaEvents(leagueId, roster, 'add', playerId);

    return { rosterPlayer, cached: false };
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
      await this.rosterMutationService.removePlayerFromRoster(
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

      // Auto-remove from trade block
      await client.query(
        'DELETE FROM trade_block_items WHERE roster_id = $1 AND player_id = $2',
        [globalRosterId, playerId]
      );

      // Add to waiver wire if league has waivers enabled
      await this.addToWaiverWireIfEnabled(league, playerId, globalRosterId, client);
    });

    // Emit events AFTER transaction commits
    this.emitFaEvents(leagueId, roster, 'drop', undefined, playerId);
  }

  /**
   * Add/drop in a single transaction
   */
  async addDropPlayer(
    leagueId: number,
    rosterId: number,
    addPlayerId: number,
    dropPlayerId: number,
    userId: string,
    idempotencyKey?: string
  ): Promise<{ rosterPlayer: RosterPlayer; cached: boolean }> {
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

    // Fast-path idempotency check (before lock)
    if (idempotencyKey) {
      const existing = await this.transactionsRepo.findByIdempotencyKey(leagueId, globalRosterId, idempotencyKey);
      if (existing) {
        const rosterPlayer = await this.rosterPlayersRepo.findByRosterAndPlayer(globalRosterId, addPlayerId);
        if (rosterPlayer) return { rosterPlayer, cached: true };
      }
    }

    // Use runWithLock with league lock to prevent concurrent free agent claims
    const rosterPlayer = await runWithLock(this.db, LockDomain.LEAGUE, leagueId, async (client) => {
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
      const rp = await this.rosterMutationService.swapPlayers(
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
        league.activeLeagueSeasonId,
        idempotencyKey
      );

      // Auto-remove dropped player from trade block
      await client.query(
        'DELETE FROM trade_block_items WHERE roster_id = $1 AND player_id = $2',
        [globalRosterId, dropPlayerId]
      );

      // Add dropped player to waiver wire if league has waivers enabled
      await this.addToWaiverWireIfEnabled(league, dropPlayerId, globalRosterId, client);

      return rp;
    });

    // Emit events AFTER transaction commits
    this.emitFaEvents(leagueId, roster, 'add_drop', addPlayerId, dropPlayerId);

    return { rosterPlayer, cached: false };
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
  ): Promise<Player[]> {
    // Validate league membership
    const isMember = await this.leagueRepo.isUserMember(leagueId, userId);
    if (!isMember) {
      throw new ForbiddenException('You are not a member of this league');
    }

    // Get league mode to determine if college players should be included
    const league = await this.leagueRepo.findById(leagueId);
    const leagueMode = league?.mode || 'redraft';

    const rows = await this.rosterPlayersRepo.getFreeAgents(leagueId, position, search, limit, offset, leagueMode, league?.activeLeagueSeasonId);
    return rows.map(playerFromDatabase);
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
