import { Pool, PoolClient } from 'pg';
import {
  WaiverPriorityRepository,
  FaabBudgetRepository,
  WaiverClaimsRepository,
  WaiverWireRepository,
} from './waivers.repository';
import { RosterPlayersRepository, RosterTransactionsRepository } from '../rosters/rosters.repository';
import { LeagueRepository, RosterRepository } from '../leagues/leagues.repository';
import { TradesRepository } from '../trades/trades.repository';
import {
  WaiverClaimWithDetails,
  WaiverPriorityWithDetails,
  FaabBudgetWithDetails,
  WaiverWirePlayerWithDetails,
  SubmitClaimRequest,
  UpdateClaimRequest,
} from './waivers.model';

// Import use-cases
import {
  submitClaim as submitClaimUseCase,
  getMyClaims as getMyClaimsUseCase,
  cancelClaim as cancelClaimUseCase,
  updateClaim as updateClaimUseCase,
  getPriorityOrder as getPriorityOrderUseCase,
  getFaabBudgets as getFaabBudgetsUseCase,
  getWaiverWirePlayers as getWaiverWirePlayersUseCase,
  initializeForSeason as initializeForSeasonUseCase,
  addToWaiverWire as addToWaiverWireUseCase,
  requiresWaiverClaim as requiresWaiverClaimUseCase,
  processLeagueClaims as processLeagueClaimsUseCase,
} from './use-cases';

/**
 * WaiversService - Facade that coordinates waiver use-cases
 *
 * This service delegates to individual use-case functions for business logic,
 * providing a unified interface for waiver operations.
 */
export class WaiversService {
  constructor(
    private readonly db: Pool,
    private readonly priorityRepo: WaiverPriorityRepository,
    private readonly faabRepo: FaabBudgetRepository,
    private readonly claimsRepo: WaiverClaimsRepository,
    private readonly waiverWireRepo: WaiverWireRepository,
    private readonly rosterRepo: RosterRepository,
    private readonly rosterPlayersRepo: RosterPlayersRepository,
    private readonly transactionsRepo: RosterTransactionsRepository,
    private readonly leagueRepo: LeagueRepository,
    private readonly tradesRepo?: TradesRepository
  ) {}

  // ==================== CLAIM MANAGEMENT ====================

  /**
   * Submit a waiver claim
   */
  async submitClaim(
    leagueId: number,
    userId: string,
    request: SubmitClaimRequest
  ): Promise<WaiverClaimWithDetails> {
    return submitClaimUseCase(
      {
        db: this.db,
        priorityRepo: this.priorityRepo,
        faabRepo: this.faabRepo,
        claimsRepo: this.claimsRepo,
        rosterRepo: this.rosterRepo,
        rosterPlayersRepo: this.rosterPlayersRepo,
        leagueRepo: this.leagueRepo,
      },
      leagueId,
      userId,
      request
    );
  }

  /**
   * Get pending claims for current user
   */
  async getMyClaims(leagueId: number, userId: string): Promise<WaiverClaimWithDetails[]> {
    return getMyClaimsUseCase(
      {
        faabRepo: this.faabRepo,
        claimsRepo: this.claimsRepo,
        rosterRepo: this.rosterRepo,
        rosterPlayersRepo: this.rosterPlayersRepo,
        leagueRepo: this.leagueRepo,
      },
      leagueId,
      userId
    );
  }

  /**
   * Cancel a pending claim
   */
  async cancelClaim(claimId: number, userId: string): Promise<void> {
    return cancelClaimUseCase(
      {
        faabRepo: this.faabRepo,
        claimsRepo: this.claimsRepo,
        rosterRepo: this.rosterRepo,
        rosterPlayersRepo: this.rosterPlayersRepo,
        leagueRepo: this.leagueRepo,
      },
      claimId,
      userId
    );
  }

  /**
   * Update claim bid amount or drop player
   */
  async updateClaim(
    claimId: number,
    userId: string,
    request: UpdateClaimRequest
  ): Promise<WaiverClaimWithDetails> {
    return updateClaimUseCase(
      {
        faabRepo: this.faabRepo,
        claimsRepo: this.claimsRepo,
        rosterRepo: this.rosterRepo,
        rosterPlayersRepo: this.rosterPlayersRepo,
        leagueRepo: this.leagueRepo,
      },
      claimId,
      userId,
      request
    );
  }

  // ==================== PRIORITY & BUDGET ====================

  /**
   * Get waiver priority order for a league
   */
  async getPriorityOrder(leagueId: number, userId: string): Promise<WaiverPriorityWithDetails[]> {
    return getPriorityOrderUseCase(
      {
        db: this.db,
        priorityRepo: this.priorityRepo,
        faabRepo: this.faabRepo,
        waiverWireRepo: this.waiverWireRepo,
        rosterRepo: this.rosterRepo,
        leagueRepo: this.leagueRepo,
      },
      leagueId,
      userId
    );
  }

  /**
   * Get FAAB budgets for a league
   */
  async getFaabBudgets(leagueId: number, userId: string): Promise<FaabBudgetWithDetails[]> {
    return getFaabBudgetsUseCase(
      {
        db: this.db,
        priorityRepo: this.priorityRepo,
        faabRepo: this.faabRepo,
        waiverWireRepo: this.waiverWireRepo,
        rosterRepo: this.rosterRepo,
        leagueRepo: this.leagueRepo,
      },
      leagueId,
      userId
    );
  }

  /**
   * Initialize waivers for a new season
   */
  async initializeForSeason(leagueId: number, season: number): Promise<void> {
    return initializeForSeasonUseCase(
      {
        db: this.db,
        priorityRepo: this.priorityRepo,
        faabRepo: this.faabRepo,
        waiverWireRepo: this.waiverWireRepo,
        rosterRepo: this.rosterRepo,
        leagueRepo: this.leagueRepo,
      },
      leagueId,
      season
    );
  }

  // ==================== WAIVER WIRE ====================

  /**
   * Get players currently on waiver wire
   */
  async getWaiverWirePlayers(leagueId: number): Promise<WaiverWirePlayerWithDetails[]> {
    return getWaiverWirePlayersUseCase(
      {
        db: this.db,
        priorityRepo: this.priorityRepo,
        faabRepo: this.faabRepo,
        waiverWireRepo: this.waiverWireRepo,
        rosterRepo: this.rosterRepo,
        leagueRepo: this.leagueRepo,
      },
      leagueId
    );
  }

  /**
   * Add player to waiver wire (called when player is dropped)
   */
  async addToWaiverWire(
    leagueId: number,
    playerId: number,
    droppedByRosterId: number,
    client?: PoolClient
  ): Promise<void> {
    return addToWaiverWireUseCase(
      {
        db: this.db,
        priorityRepo: this.priorityRepo,
        faabRepo: this.faabRepo,
        waiverWireRepo: this.waiverWireRepo,
        rosterRepo: this.rosterRepo,
        leagueRepo: this.leagueRepo,
      },
      leagueId,
      playerId,
      droppedByRosterId,
      client
    );
  }

  /**
   * Check if player requires waiver claim (on waiver wire or waivers always required)
   */
  async requiresWaiverClaim(leagueId: number, playerId: number): Promise<boolean> {
    return requiresWaiverClaimUseCase(
      {
        db: this.db,
        priorityRepo: this.priorityRepo,
        faabRepo: this.faabRepo,
        waiverWireRepo: this.waiverWireRepo,
        rosterRepo: this.rosterRepo,
        leagueRepo: this.leagueRepo,
      },
      leagueId,
      playerId
    );
  }

  // ==================== PROCESSING ====================

  /**
   * Process waiver claims for a specific league
   */
  async processLeagueClaims(
    leagueId: number
  ): Promise<{ processed: number; successful: number }> {
    return processLeagueClaimsUseCase(
      {
        db: this.db,
        priorityRepo: this.priorityRepo,
        faabRepo: this.faabRepo,
        claimsRepo: this.claimsRepo,
        waiverWireRepo: this.waiverWireRepo,
        rosterRepo: this.rosterRepo,
        rosterPlayersRepo: this.rosterPlayersRepo,
        transactionsRepo: this.transactionsRepo,
        leagueRepo: this.leagueRepo,
        tradesRepo: this.tradesRepo,
      },
      leagueId
    );
  }
}
