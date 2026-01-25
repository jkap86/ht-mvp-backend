import { Pool, PoolClient } from 'pg';
import {
  WaiverPriorityRepository,
  FaabBudgetRepository,
  WaiverClaimsRepository,
  WaiverWireRepository,
} from './waivers.repository';
import { RosterPlayersRepository, RosterTransactionsRepository } from '../rosters/rosters.repository';
import { LeagueRepository, RosterRepository } from '../leagues/leagues.repository';
import { getSocketService } from '../../socket';
import {
  WaiverClaim,
  WaiverClaimWithDetails,
  WaiverPriorityWithDetails,
  FaabBudgetWithDetails,
  WaiverWirePlayerWithDetails,
  SubmitClaimRequest,
  UpdateClaimRequest,
  WaiverType,
  parseWaiverSettings,
  waiverClaimToResponse,
  waiverPriorityToResponse,
  faabBudgetToResponse,
} from './waivers.model';
import {
  NotFoundException,
  ForbiddenException,
  ValidationException,
  ConflictException,
} from '../../utils/exceptions';

const WAIVER_LOCK_OFFSET = 3000000;

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
    private readonly leagueRepo: LeagueRepository
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
    // Validate user owns a roster in this league
    const roster = await this.rosterRepo.findByLeagueAndUser(leagueId, userId);
    if (!roster) {
      throw new ForbiddenException('You are not a member of this league');
    }

    // Get league and waiver settings
    const league = await this.leagueRepo.findById(leagueId);
    if (!league) throw new NotFoundException('League not found');

    const settings = parseWaiverSettings(league.settings);
    if (settings.waiverType === 'none') {
      throw new ValidationException('Waivers are disabled for this league');
    }

    const season = parseInt(league.season, 10);
    const currentWeek = league.currentWeek || 1;

    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [leagueId + WAIVER_LOCK_OFFSET]);

      // Check if player is already owned
      const playerOwner = await this.rosterPlayersRepo.findOwner(leagueId, request.playerId, client);
      if (playerOwner) {
        throw new ValidationException('Player is already on a roster');
      }

      // Check if user already has a pending claim for this player
      const existingClaim = await this.claimsRepo.hasPendingClaim(roster.id, request.playerId, client);
      if (existingClaim) {
        throw new ConflictException('You already have a pending claim for this player');
      }

      // Validate FAAB bid if applicable
      let bidAmount = request.bidAmount || 0;
      if (settings.waiverType === 'faab') {
        const budget = await this.faabRepo.getByRoster(roster.id, season, client);
        if (!budget) {
          throw new ValidationException('FAAB budget not initialized');
        }
        if (bidAmount > budget.remainingBudget) {
          throw new ValidationException(`Bid exceeds available budget ($${budget.remainingBudget})`);
        }
        if (bidAmount < 0) {
          throw new ValidationException('Bid amount cannot be negative');
        }
      }

      // Validate drop player if provided
      if (request.dropPlayerId) {
        const hasPlayer = await this.rosterPlayersRepo.findByRosterAndPlayer(
          roster.id,
          request.dropPlayerId,
          client
        );
        if (!hasPlayer) {
          throw new ValidationException('You do not own the player to drop');
        }
      }

      // Get priority snapshot for standard waivers
      let priorityAtClaim: number | null = null;
      if (settings.waiverType === 'standard') {
        const priority = await this.priorityRepo.getByRoster(roster.id, season, client);
        priorityAtClaim = priority?.priority ?? null;
      }

      // Create the claim
      const claim = await this.claimsRepo.create(
        leagueId,
        roster.id,
        request.playerId,
        request.dropPlayerId || null,
        bidAmount,
        priorityAtClaim,
        season,
        currentWeek,
        client
      );

      await client.query('COMMIT');

      // Get full details for response
      const claimWithDetails = await this.claimsRepo.findByIdWithDetails(claim.id);
      if (!claimWithDetails) throw new Error('Failed to get claim details');

      // Emit socket event
      try {
        const socket = getSocketService();
        socket.emitWaiverClaimSubmitted(leagueId, waiverClaimToResponse(claimWithDetails));
      } catch (socketError) {
        console.warn('Failed to emit waiver claim submitted event:', socketError);
      }

      return claimWithDetails;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Get pending claims for current user
   */
  async getMyClaims(leagueId: number, userId: string): Promise<WaiverClaimWithDetails[]> {
    const roster = await this.rosterRepo.findByLeagueAndUser(leagueId, userId);
    if (!roster) {
      throw new ForbiddenException('You are not a member of this league');
    }

    return this.claimsRepo.getPendingByRoster(roster.id);
  }

  /**
   * Cancel a pending claim
   */
  async cancelClaim(claimId: number, userId: string): Promise<void> {
    const claim = await this.claimsRepo.findById(claimId);
    if (!claim) {
      throw new NotFoundException('Claim not found');
    }

    // Verify ownership
    const roster = await this.rosterRepo.findById(claim.rosterId);
    if (!roster || roster.userId !== userId) {
      throw new ForbiddenException('You do not own this claim');
    }

    if (claim.status !== 'pending') {
      throw new ValidationException('Can only cancel pending claims');
    }

    await this.claimsRepo.updateStatus(claimId, 'cancelled');

    // Emit socket event
    try {
      const socket = getSocketService();
      socket.emitWaiverClaimCancelled(claim.leagueId, { claimId, rosterId: claim.rosterId });
    } catch (socketError) {
      console.warn('Failed to emit waiver claim cancelled event:', socketError);
    }
  }

  /**
   * Update claim bid amount or drop player
   */
  async updateClaim(
    claimId: number,
    userId: string,
    request: UpdateClaimRequest
  ): Promise<WaiverClaimWithDetails> {
    const claim = await this.claimsRepo.findById(claimId);
    if (!claim) {
      throw new NotFoundException('Claim not found');
    }

    // Verify ownership
    const roster = await this.rosterRepo.findById(claim.rosterId);
    if (!roster || roster.userId !== userId) {
      throw new ForbiddenException('You do not own this claim');
    }

    if (claim.status !== 'pending') {
      throw new ValidationException('Can only update pending claims');
    }

    const league = await this.leagueRepo.findById(claim.leagueId);
    if (!league) throw new NotFoundException('League not found');

    const settings = parseWaiverSettings(league.settings);
    const season = parseInt(league.season, 10);

    // Update bid amount if provided
    if (request.bidAmount !== undefined && settings.waiverType === 'faab') {
      const budget = await this.faabRepo.getByRoster(roster.id, season);
      if (!budget) {
        throw new ValidationException('FAAB budget not initialized');
      }
      if (request.bidAmount > budget.remainingBudget) {
        throw new ValidationException(`Bid exceeds available budget ($${budget.remainingBudget})`);
      }
      if (request.bidAmount < 0) {
        throw new ValidationException('Bid amount cannot be negative');
      }
      await this.claimsRepo.updateBid(claimId, request.bidAmount);
    }

    // Update drop player if provided
    if (request.dropPlayerId !== undefined) {
      if (request.dropPlayerId !== null) {
        const hasPlayer = await this.rosterPlayersRepo.findByRosterAndPlayer(
          roster.id,
          request.dropPlayerId
        );
        if (!hasPlayer) {
          throw new ValidationException('You do not own the player to drop');
        }
      }
      await this.claimsRepo.updateDropPlayer(claimId, request.dropPlayerId);
    }

    const claimWithDetails = await this.claimsRepo.findByIdWithDetails(claimId);
    if (!claimWithDetails) throw new Error('Failed to get claim details');

    // Emit socket event
    try {
      const socket = getSocketService();
      socket.emitWaiverClaimUpdated(claim.leagueId, waiverClaimToResponse(claimWithDetails));
    } catch (socketError) {
      console.warn('Failed to emit waiver claim updated event:', socketError);
    }

    return claimWithDetails;
  }

  // ==================== PRIORITY & BUDGET ====================

  /**
   * Get waiver priority order for a league
   */
  async getPriorityOrder(leagueId: number, userId: string): Promise<WaiverPriorityWithDetails[]> {
    // Verify user is in league
    const roster = await this.rosterRepo.findByLeagueAndUser(leagueId, userId);
    if (!roster) {
      throw new ForbiddenException('You are not a member of this league');
    }

    const league = await this.leagueRepo.findById(leagueId);
    if (!league) throw new NotFoundException('League not found');

    const season = parseInt(league.season, 10);
    return this.priorityRepo.getByLeague(leagueId, season);
  }

  /**
   * Get FAAB budgets for a league
   */
  async getFaabBudgets(leagueId: number, userId: string): Promise<FaabBudgetWithDetails[]> {
    // Verify user is in league
    const roster = await this.rosterRepo.findByLeagueAndUser(leagueId, userId);
    if (!roster) {
      throw new ForbiddenException('You are not a member of this league');
    }

    const league = await this.leagueRepo.findById(leagueId);
    if (!league) throw new NotFoundException('League not found');

    const season = parseInt(league.season, 10);
    return this.faabRepo.getByLeague(leagueId, season);
  }

  /**
   * Initialize waivers for a new season
   */
  async initializeForSeason(leagueId: number, season: number): Promise<void> {
    const league = await this.leagueRepo.findById(leagueId);
    if (!league) throw new NotFoundException('League not found');

    const settings = parseWaiverSettings(league.settings);
    if (settings.waiverType === 'none') return;

    // Get all rosters in the league
    const rosters = await this.rosterRepo.findByLeagueId(leagueId);
    const rosterIds = rosters.map(r => r.id);

    const client = await this.db.connect();
    try {
      await client.query('BEGIN');

      // Initialize priorities
      await this.priorityRepo.initializeForLeague(leagueId, season, rosterIds, client);

      // Initialize FAAB budgets if FAAB mode
      if (settings.waiverType === 'faab') {
        await this.faabRepo.initializeForLeague(
          leagueId,
          season,
          rosterIds,
          settings.faabBudget,
          client
        );
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  // ==================== WAIVER WIRE ====================

  /**
   * Get players currently on waiver wire
   */
  async getWaiverWirePlayers(leagueId: number): Promise<WaiverWirePlayerWithDetails[]> {
    return this.waiverWireRepo.getByLeague(leagueId);
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
    const league = await this.leagueRepo.findById(leagueId);
    if (!league) return;

    const settings = parseWaiverSettings(league.settings);
    if (settings.waiverType === 'none') return;

    const season = parseInt(league.season, 10);
    const currentWeek = league.currentWeek || 1;

    // Calculate expiration
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + settings.waiverPeriodDays);

    await this.waiverWireRepo.addPlayer(
      leagueId,
      playerId,
      droppedByRosterId,
      expiresAt,
      season,
      currentWeek,
      client
    );
  }

  /**
   * Check if player requires waiver claim (on waiver wire or waivers always required)
   */
  async requiresWaiverClaim(leagueId: number, playerId: number): Promise<boolean> {
    const league = await this.leagueRepo.findById(leagueId);
    if (!league) return false;

    const settings = parseWaiverSettings(league.settings);

    // If waivers are disabled, never require claim
    if (settings.waiverType === 'none') return false;

    // If player is on waiver wire, always require claim
    const isOnWaivers = await this.waiverWireRepo.isOnWaivers(leagueId, playerId);
    if (isOnWaivers) return true;

    // In some leagues, all free agents require waivers - for now, only waiver wire players require claims
    return false;
  }

  // ==================== PROCESSING ====================

  /**
   * Process waiver claims for a specific league
   */
  async processLeagueClaims(
    leagueId: number
  ): Promise<{ processed: number; successful: number }> {
    const league = await this.leagueRepo.findById(leagueId);
    if (!league) throw new NotFoundException('League not found');

    const settings = parseWaiverSettings(league.settings);
    if (settings.waiverType === 'none') {
      return { processed: 0, successful: 0 };
    }

    const season = parseInt(league.season, 10);

    const client = await this.db.connect();
    let processed = 0;
    let successful = 0;

    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [leagueId + WAIVER_LOCK_OFFSET]);

      // Get all pending claims grouped by player
      const pendingClaims = await this.claimsRepo.getPendingByLeague(leagueId, client);

      // Group claims by player
      const claimsByPlayer = new Map<number, WaiverClaim[]>();
      for (const claim of pendingClaims) {
        const existing = claimsByPlayer.get(claim.playerId) || [];
        existing.push(claim);
        claimsByPlayer.set(claim.playerId, existing);
      }

      // Process each player's claims
      for (const [playerId, claims] of claimsByPlayer) {
        // Sort claims by priority/bid
        const sortedClaims = this.sortClaimsByPriority(claims, settings.waiverType);

        let winner: WaiverClaim | null = null;

        // Find first eligible winner
        for (const claim of sortedClaims) {
          const canExecute = await this.canExecuteClaim(claim, settings.waiverType, season, client);
          if (canExecute) {
            winner = claim;
            break;
          }
        }

        // Execute winner, fail others
        for (const claim of sortedClaims) {
          processed++;

          if (winner && claim.id === winner.id) {
            await this.executeClaim(claim, settings.waiverType, season, client);
            await this.claimsRepo.updateStatus(claim.id, 'successful', undefined, client);
            successful++;

            // Emit success to user
            try {
              const roster = await this.rosterRepo.findById(claim.rosterId);
              if (roster && roster.userId) {
                const socket = getSocketService();
                const claimWithDetails = await this.claimsRepo.findByIdWithDetails(claim.id);
                if (claimWithDetails) {
                  socket.emitWaiverClaimSuccessful(roster.userId, waiverClaimToResponse(claimWithDetails));
                }
              }
            } catch (socketError) {
              console.warn('Failed to emit waiver claim successful:', socketError);
            }
          } else {
            const reason = winner ? 'Outbid by another team' : 'Could not process claim';
            await this.claimsRepo.updateStatus(claim.id, 'failed', reason, client);

            // Emit failure to user
            try {
              const roster = await this.rosterRepo.findById(claim.rosterId);
              if (roster && roster.userId) {
                const socket = getSocketService();
                socket.emitWaiverClaimFailed(roster.userId, { claimId: claim.id, reason });
              }
            } catch (socketError) {
              console.warn('Failed to emit waiver claim failed:', socketError);
            }
          }
        }

        // Remove player from waiver wire after being claimed
        if (winner) {
          await this.waiverWireRepo.removePlayer(leagueId, playerId, client);
        }
      }

      await client.query('COMMIT');

      // Emit priorities updated if any successful claims in standard mode
      if (successful > 0 && settings.waiverType === 'standard') {
        try {
          const priorities = await this.priorityRepo.getByLeague(leagueId, season);
          const socket = getSocketService();
          socket.emitWaiverPriorityUpdated(leagueId, priorities.map(waiverPriorityToResponse));
        } catch (socketError) {
          console.warn('Failed to emit priority updated:', socketError);
        }
      }

      // Emit budgets updated if any successful claims in FAAB mode
      if (successful > 0 && settings.waiverType === 'faab') {
        try {
          const budgets = await this.faabRepo.getByLeague(leagueId, season);
          const socket = getSocketService();
          socket.emitWaiverBudgetUpdated(leagueId, budgets.map(faabBudgetToResponse));
        } catch (socketError) {
          console.warn('Failed to emit budget updated:', socketError);
        }
      }

      return { processed, successful };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Sort claims by priority (standard) or bid amount (FAAB)
   */
  private sortClaimsByPriority(claims: WaiverClaim[], waiverType: WaiverType): WaiverClaim[] {
    return [...claims].sort((a, b) => {
      if (waiverType === 'faab') {
        // Higher bid wins
        if (a.bidAmount !== b.bidAmount) return b.bidAmount - a.bidAmount;
        // Tiebreaker: priority (lower wins)
        if (a.priorityAtClaim !== null && b.priorityAtClaim !== null) {
          if (a.priorityAtClaim !== b.priorityAtClaim) return a.priorityAtClaim - b.priorityAtClaim;
        }
      } else {
        // Standard: lower priority number wins
        if (a.priorityAtClaim !== null && b.priorityAtClaim !== null) {
          if (a.priorityAtClaim !== b.priorityAtClaim) return a.priorityAtClaim - b.priorityAtClaim;
        }
      }
      // Final tiebreaker: earlier claim wins
      return a.createdAt.getTime() - b.createdAt.getTime();
    });
  }

  /**
   * Check if a claim can be executed
   */
  private async canExecuteClaim(
    claim: WaiverClaim,
    waiverType: WaiverType,
    season: number,
    client: PoolClient
  ): Promise<boolean> {
    // Check if player is still available
    const owner = await this.rosterPlayersRepo.findOwner(claim.leagueId, claim.playerId, client);
    if (owner) return false;

    // Check FAAB budget
    if (waiverType === 'faab' && claim.bidAmount > 0) {
      const budget = await this.faabRepo.getByRoster(claim.rosterId, season, client);
      if (!budget || budget.remainingBudget < claim.bidAmount) return false;
    }

    // Check if drop player still on roster (if specified)
    if (claim.dropPlayerId) {
      const hasDropPlayer = await this.rosterPlayersRepo.findByRosterAndPlayer(
        claim.rosterId,
        claim.dropPlayerId,
        client
      );
      if (!hasDropPlayer) return false;
    }

    // Check roster has space (if no drop player)
    if (!claim.dropPlayerId) {
      const league = await this.leagueRepo.findById(claim.leagueId);
      if (!league) return false;

      const rosterSize = await this.rosterPlayersRepo.getPlayerCount(claim.rosterId, client);
      const maxSize = league.settings?.roster_size || 15;
      if (rosterSize >= maxSize) return false;
    }

    return true;
  }

  /**
   * Execute a successful claim
   */
  private async executeClaim(
    claim: WaiverClaim,
    waiverType: WaiverType,
    season: number,
    client: PoolClient
  ): Promise<void> {
    // Drop player first if specified
    if (claim.dropPlayerId) {
      await this.rosterPlayersRepo.removePlayer(claim.rosterId, claim.dropPlayerId, client);

      // Record drop transaction
      await this.transactionsRepo.create(
        claim.leagueId,
        claim.rosterId,
        claim.dropPlayerId,
        'drop',
        claim.season,
        claim.week,
        undefined,
        client
      );

      // Add dropped player to waiver wire
      await this.addToWaiverWire(claim.leagueId, claim.dropPlayerId, claim.rosterId, client);
    }

    // Add player to roster
    await this.rosterPlayersRepo.addPlayer(claim.rosterId, claim.playerId, 'waiver', client);

    // Record add transaction
    await this.transactionsRepo.create(
      claim.leagueId,
      claim.rosterId,
      claim.playerId,
      'add',
      claim.season,
      claim.week,
      undefined,
      client
    );

    // Deduct FAAB budget if applicable
    if (waiverType === 'faab' && claim.bidAmount > 0) {
      await this.faabRepo.deductBudget(claim.rosterId, season, claim.bidAmount, client);
    }

    // Rotate priority for standard waivers
    if (waiverType === 'standard') {
      await this.priorityRepo.rotatePriority(claim.leagueId, season, claim.rosterId, client);
    }
  }
}
