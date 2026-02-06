import { PoolClient } from 'pg';
import { RosterPlayersRepository } from './rosters.repository';
import { LeagueRepository } from '../leagues/leagues.repository';
import { RosterPlayer, AcquiredType } from './rosters.model';
import { ValidationException, ConflictException, NotFoundException } from '../../utils/exceptions';

/**
 * Options for skipping validation checks.
 * Use with care - these bypass safety invariants.
 */
export interface MutationOptions {
  /** Skip ownership check (e.g., for drafts where player isn't in league system yet) */
  skipOwnershipCheck?: boolean;
  /** Skip roster size check (e.g., for trades where two-pass pattern handles this) */
  skipRosterSizeCheck?: boolean;
}

export interface AddPlayerParams {
  rosterId: number;
  playerId: number;
  leagueId: number;
  acquiredType: AcquiredType;
}

export interface RemovePlayerParams {
  rosterId: number;
  playerId: number;
}

export interface SwapPlayersParams {
  rosterId: number;
  addPlayerId: number;
  dropPlayerId: number;
  leagueId: number;
  acquiredType: AcquiredType;
}

export interface BulkRemoveParams {
  leagueId: number;
  removals: Array<{ rosterId: number; playerId: number }>;
}

export interface BulkAddParams {
  leagueId: number;
  additions: Array<{ rosterId: number; playerId: number; acquiredType: AcquiredType }>;
}

/**
 * Centralized roster mutation service.
 * Enforces consistent validation invariants across all roster modifications:
 * - Draft completion
 * - Trade execution
 * - Waiver processing
 * - Free agency
 *
 * NOTE: This service does NOT manage transactions - caller's responsibility.
 * NOTE: Transaction recording (roster_transactions) is NOT handled here - different
 *       features need different metadata (season, week, related_transaction_id).
 */
export class RosterMutationService {
  constructor(
    private readonly rosterPlayersRepo: RosterPlayersRepository,
    private readonly leagueRepo: LeagueRepository
  ) {}

  /**
   * Add a player to a roster.
   *
   * Validates:
   * - Player is not already owned in league (unless skipOwnershipCheck)
   * - Roster is not at max capacity (unless skipRosterSizeCheck)
   *
   * @param params - Add player parameters
   * @param options - Optional validation skip flags
   * @param client - Optional transaction client
   */
  async addPlayerToRoster(
    params: AddPlayerParams,
    options: MutationOptions = {},
    client?: PoolClient
  ): Promise<RosterPlayer> {
    const { rosterId, playerId, leagueId, acquiredType } = params;

    // Check ownership unless skipped (e.g., drafts)
    if (!options.skipOwnershipCheck) {
      const owner = await this.rosterPlayersRepo.findOwner(leagueId, playerId, client);
      if (owner) {
        throw new ConflictException('Player is already on a roster');
      }
    }

    // Check roster size unless skipped (e.g., two-pass trades)
    if (!options.skipRosterSizeCheck) {
      const league = await this.leagueRepo.findById(leagueId);
      if (!league) {
        throw new NotFoundException('League not found');
      }

      const rosterSize = await this.rosterPlayersRepo.getPlayerCount(rosterId, client);
      const maxRosterSize = league.settings?.roster_size || 15;

      if (rosterSize >= maxRosterSize) {
        throw new ValidationException(`Roster is full (${maxRosterSize} players max)`);
      }
    }

    return this.rosterPlayersRepo.addPlayer(rosterId, playerId, acquiredType, client);
  }

  /**
   * Remove a player from a roster.
   *
   * Validates:
   * - Player exists on the roster
   *
   * @param params - Remove player parameters
   * @param client - Optional transaction client
   */
  async removePlayerFromRoster(params: RemovePlayerParams, client?: PoolClient): Promise<void> {
    const { rosterId, playerId } = params;

    const existing = await this.rosterPlayersRepo.findByRosterAndPlayer(rosterId, playerId, client);
    if (!existing) {
      throw new NotFoundException('Player is not on this roster');
    }

    await this.rosterPlayersRepo.removePlayer(rosterId, playerId, client);
  }

  /**
   * Swap players: drop one, add another in a single operation.
   * No roster size check needed since we're freeing a slot.
   *
   * Validates:
   * - Player to drop exists on roster
   * - Player to add is not already owned in league
   *
   * @param params - Swap players parameters
   * @param client - Optional transaction client
   */
  async swapPlayers(params: SwapPlayersParams, client?: PoolClient): Promise<RosterPlayer> {
    const { rosterId, addPlayerId, dropPlayerId, leagueId, acquiredType } = params;

    // Check player to add is not owned
    const owner = await this.rosterPlayersRepo.findOwner(leagueId, addPlayerId, client);
    if (owner) {
      throw new ConflictException('Player is already on a roster');
    }

    // Check player to drop is on roster
    const existing = await this.rosterPlayersRepo.findByRosterAndPlayer(
      rosterId,
      dropPlayerId,
      client
    );
    if (!existing) {
      throw new NotFoundException('Player to drop is not on this roster');
    }

    // Drop first, then add
    await this.rosterPlayersRepo.removePlayer(rosterId, dropPlayerId, client);
    return this.rosterPlayersRepo.addPlayer(rosterId, addPlayerId, acquiredType, client);
  }

  /**
   * Bulk remove players from rosters (trade pass 1).
   * Validates all players exist on their respective rosters before removing any.
   *
   * @param params - Bulk remove parameters
   * @param client - Optional transaction client
   */
  async bulkRemovePlayers(params: BulkRemoveParams, client?: PoolClient): Promise<void> {
    const { removals } = params;

    // Validate all exist before removing any (parallelized for performance)
    const existenceChecks = await Promise.all(
      removals.map(({ rosterId, playerId }) =>
        this.rosterPlayersRepo.findByRosterAndPlayer(rosterId, playerId, client)
      )
    );
    const missingIdx = existenceChecks.findIndex((e) => !e);
    if (missingIdx !== -1) {
      const { rosterId, playerId } = removals[missingIdx];
      throw new ConflictException(`Player ${playerId} is no longer on roster ${rosterId}`);
    }

    // Remove all (sequential to maintain transaction ordering)
    for (const { rosterId, playerId } of removals) {
      await this.rosterPlayersRepo.removePlayer(rosterId, playerId, client);
    }
  }

  /**
   * Bulk add players to rosters (trade pass 2).
   * Validates roster size for each add - assumes removals already done.
   *
   * @param params - Bulk add parameters
   * @param client - Optional transaction client
   */
  async bulkAddPlayers(params: BulkAddParams, client?: PoolClient): Promise<RosterPlayer[]> {
    const { leagueId, additions } = params;

    const league = await this.leagueRepo.findById(leagueId);
    if (!league) {
      throw new NotFoundException('League not found');
    }

    const maxRosterSize = league.settings?.roster_size || 15;
    const results: RosterPlayer[] = [];

    for (const { rosterId, playerId, acquiredType } of additions) {
      // Check roster size for each add (accounts for previous adds in this batch)
      const rosterSize = await this.rosterPlayersRepo.getPlayerCount(rosterId, client);
      if (rosterSize >= maxRosterSize) {
        throw new ValidationException(
          `Roster ${rosterId} is full. Cannot add player ${playerId}.`
        );
      }

      const rosterPlayer = await this.rosterPlayersRepo.addPlayer(
        rosterId,
        playerId,
        acquiredType,
        client
      );
      results.push(rosterPlayer);
    }

    return results;
  }
}
