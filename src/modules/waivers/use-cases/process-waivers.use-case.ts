import { PoolClient } from 'pg';
import { WaiverClaimsRepository, WaiverClaimWithCurrentPriority } from '../waivers.repository';
import {
  RosterPlayersRepository,
  RosterTransactionsRepository,
} from '../../rosters/rosters.repository';
import { RosterMutationService } from '../../rosters/roster-mutation.service';
import { TradesRepository } from '../../trades/trades.repository';
import { DomainEventBus, EventTypes, tryGetEventBus } from '../../../shared/events';
import { container, KEYS } from '../../../container';
import {
  WaiverClaim,
  WaiverType,
  parseWaiverSettings,
  waiverClaimToResponse,
  waiverPriorityToResponse,
  faabBudgetToResponse,
  resolveLeagueCurrentWeek,
} from '../waivers.model';
import { NotFoundException } from '../../../utils/exceptions';
import { runWithLock, LockDomain } from '../../../shared/transaction-runner';
import { addToWaiverWire, WaiverInfoContext } from './waiver-info.use-case';
import { EventListenerService } from '../../chat/event-listener.service';
import { logger } from '../../../config/logger.config';

export interface ProcessWaiversContext extends WaiverInfoContext {
  claimsRepo: WaiverClaimsRepository;
  rosterPlayersRepo: RosterPlayersRepository;
  transactionsRepo: RosterTransactionsRepository;
  tradesRepo?: TradesRepository;
  eventListenerService?: EventListenerService;
  rosterMutationService?: RosterMutationService;
}

/**
 * Process waiver claims for a specific league
 * Now properly scoped to current season/week and uses live priority for winner selection
 */
export async function processLeagueClaims(
  ctx: ProcessWaiversContext,
  leagueId: number
): Promise<{ processed: number; successful: number }> {
  const league = await ctx.leagueRepo.findById(leagueId);
  if (!league) throw new NotFoundException('League not found');

  const settings = parseWaiverSettings(league.settings);
  if (settings.waiverType === 'none') {
    return { processed: 0, successful: 0 };
  }

  const season = parseInt(league.season, 10);
  const currentWeek = resolveLeagueCurrentWeek(league);

  // Skip processing if no current week set (pre-season)
  if (currentWeek === null) {
    logger.debug(`League ${leagueId} has no current week, skipping waiver processing`);
    return { processed: 0, successful: 0 };
  }

  const maxRosterSize = league.settings?.roster_size || 15;

  // Collect events to emit AFTER commit to prevent UI desync on rollback
  const pendingEvents: Array<() => void | Promise<void>> = [];

  const { processed, successful } = await runWithLock(
    ctx.db,
    LockDomain.WAIVER,
    leagueId,
    async (client) => {
      let processedCount = 0;
      let successfulCount = 0;

      // Get all pending claims with CURRENT priority (not snapshot) for current season/week
      const pendingClaims = await ctx.claimsRepo.getPendingByLeagueWithCurrentPriority(
        leagueId,
        season,
        currentWeek,
        client
      );

      if (pendingClaims.length === 0) {
        return { processed: 0, successful: 0 };
      }

      // Build in-memory priority map for tracking rotations within this run
      // This ensures priority changes from earlier claims affect later claims
      const priorityByRoster = new Map<number, number>();
      let maxPriority = 0;
      for (const claim of pendingClaims) {
        if (claim.currentPriority !== null && !priorityByRoster.has(claim.rosterId)) {
          priorityByRoster.set(claim.rosterId, claim.currentPriority);
          maxPriority = Math.max(maxPriority, claim.currentPriority);
        }
      }

      // Group claims by player
      const claimsByPlayer = new Map<number, WaiverClaimWithCurrentPriority[]>();
      for (const claim of pendingClaims) {
        const existing = claimsByPlayer.get(claim.playerId) || [];
        existing.push(claim);
        claimsByPlayer.set(claim.playerId, existing);
      }

      // Process each player's claims
      for (const [playerId, claims] of claimsByPlayer) {
        // Sort claims using in-memory priority (reflects rotations from earlier wins)
        const sortedClaims = sortClaimsByCurrentPriority(claims, settings.waiverType, priorityByRoster);

        let winner: WaiverClaimWithCurrentPriority | null = null;

        // Find first eligible winner
        for (const claim of sortedClaims) {
          const canExecute = await canExecuteClaim(ctx, claim, settings.waiverType, season, maxRosterSize, client);
          if (canExecute) {
            winner = claim;
            break;
          }
        }

        // Execute winner, fail others
        for (const claim of sortedClaims) {
          processedCount++;

          if (winner && claim.id === winner.id) {
            await executeClaim(ctx, claim, settings.waiverType, season, client);
            await ctx.claimsRepo.updateStatus(claim.id, 'successful', undefined, client);
            successfulCount++;

            // Update in-memory priority map for standard waivers
            // Winner moves to last place, everyone who was behind them shifts up
            if (settings.waiverType === 'standard') {
              const winnerOldPriority = priorityByRoster.get(winner.rosterId);
              if (winnerOldPriority !== undefined) {
                // Shift everyone who was behind the winner up by 1
                for (const [rosterId, priority] of priorityByRoster) {
                  if (priority > winnerOldPriority) {
                    priorityByRoster.set(rosterId, priority - 1);
                  }
                }
                // Winner goes to max priority (last place)
                priorityByRoster.set(winner.rosterId, maxPriority);
              }
            }

            // Queue success emit for after commit
            const claimCopy = { ...claim };
            pendingEvents.push(() => emitClaimSuccessful(ctx, claimCopy));
          } else {
            const reason = winner ? 'Outbid by another team' : 'Could not process claim';
            await ctx.claimsRepo.updateStatus(claim.id, 'failed', reason, client);

            // Queue failure emit for after commit
            const claimCopy = { ...claim };
            pendingEvents.push(() => emitClaimFailed(ctx, claimCopy, reason));
          }
        }

        // Remove player from waiver wire after being claimed
        if (winner) {
          await ctx.waiverWireRepo.removePlayer(leagueId, playerId, client);

          // Invalidate pending trades involving the claimed player
          if (ctx.tradesRepo) {
            const invalidatedTrades = await invalidateTradesForPlayer(
              ctx,
              leagueId,
              playerId,
              client
            );
            // Queue trade invalidation emits for after commit
            for (const trade of invalidatedTrades) {
              pendingEvents.push(() => emitTradeInvalidated(trade.leagueId, trade.id));
            }
            // Also invalidate trades involving the dropped player if any
            if (winner.dropPlayerId) {
              const droppedPlayerTrades = await invalidateTradesForPlayer(
                ctx,
                leagueId,
                winner.dropPlayerId,
                client
              );
              for (const trade of droppedPlayerTrades) {
                pendingEvents.push(() => emitTradeInvalidated(trade.leagueId, trade.id));
              }
            }
          }
        }
      }

      return { processed: processedCount, successful: successfulCount };
    }
  );

  // Now emit all queued events AFTER successful commit
  for (const emit of pendingEvents) {
    await emit();
  }

  // Emit priorities updated if any successful claims in standard mode
  if (successful > 0 && settings.waiverType === 'standard') {
    emitPriorityUpdated(ctx, leagueId, season);
  }

  // Emit budgets updated if any successful claims in FAAB mode
  if (successful > 0 && settings.waiverType === 'faab') {
    emitBudgetUpdated(ctx, leagueId, season);
  }

  // Emit waiver processed system message if any claims were processed
  if (processed > 0 && ctx.eventListenerService) {
    ctx.eventListenerService
      .handleWaiverProcessed(leagueId)
      .catch((err) => logger.warn('Failed to emit system message', {
        type: 'waiver_processed',
        leagueId,
        error: err.message
      }));
  }

  return { processed, successful };
}

/**
 * Sort claims by current priority (from in-memory map that tracks rotations)
 * For FAAB: highest bid wins, priority is tiebreaker
 * For Standard: lowest priority number wins
 */
function sortClaimsByCurrentPriority(
  claims: WaiverClaimWithCurrentPriority[],
  waiverType: WaiverType,
  priorityByRoster: Map<number, number>
): WaiverClaimWithCurrentPriority[] {
  return [...claims].sort((a, b) => {
    // Get current priority from in-memory map (reflects rotations within this run)
    const aPriority = priorityByRoster.get(a.rosterId) ?? a.currentPriority ?? a.priorityAtClaim ?? Infinity;
    const bPriority = priorityByRoster.get(b.rosterId) ?? b.currentPriority ?? b.priorityAtClaim ?? Infinity;

    if (waiverType === 'faab') {
      // Higher bid wins
      if (a.bidAmount !== b.bidAmount) return b.bidAmount - a.bidAmount;
      // Tiebreaker: priority (lower wins)
      if (aPriority !== bPriority) return aPriority - bPriority;
    } else {
      // Standard: lower priority number wins
      if (aPriority !== bPriority) return aPriority - bPriority;
    }
    // Final tiebreaker: earlier claim wins
    return a.createdAt.getTime() - b.createdAt.getTime();
  });
}

/**
 * Check if a claim can be executed
 */
async function canExecuteClaim(
  ctx: ProcessWaiversContext,
  claim: WaiverClaim,
  waiverType: WaiverType,
  season: number,
  maxRosterSize: number,
  client: PoolClient
): Promise<boolean> {
  // Check if player is still available
  const owner = await ctx.rosterPlayersRepo.findOwner(claim.leagueId, claim.playerId, client);
  if (owner) return false;

  // Check FAAB budget
  if (waiverType === 'faab' && claim.bidAmount > 0) {
    const budget = await ctx.faabRepo.getByRoster(claim.rosterId, season, client);
    if (!budget || budget.remainingBudget < claim.bidAmount) return false;
  }

  // Check if drop player still on roster (if specified)
  if (claim.dropPlayerId) {
    const hasDropPlayer = await ctx.rosterPlayersRepo.findByRosterAndPlayer(
      claim.rosterId,
      claim.dropPlayerId,
      client
    );
    if (!hasDropPlayer) return false;
  }

  // Check roster has space (if no drop player)
  if (!claim.dropPlayerId) {
    const rosterSize = await ctx.rosterPlayersRepo.getPlayerCount(claim.rosterId, client);
    if (rosterSize >= maxRosterSize) return false;
  }

  return true;
}

/**
 * Execute a successful claim
 */
async function executeClaim(
  ctx: ProcessWaiversContext,
  claim: WaiverClaim,
  waiverType: WaiverType,
  season: number,
  client: PoolClient
): Promise<void> {
  // Get mutation service from context or container
  const mutationService =
    ctx.rosterMutationService ?? container.resolve<RosterMutationService>(KEYS.ROSTER_MUTATION_SERVICE);

  // Drop player first if specified
  if (claim.dropPlayerId) {
    await mutationService.removePlayerFromRoster(
      { rosterId: claim.rosterId, playerId: claim.dropPlayerId },
      client
    );

    // Record drop transaction
    await ctx.transactionsRepo.create(
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
    await addToWaiverWire(ctx, claim.leagueId, claim.dropPlayerId, claim.rosterId, client);
  }

  // Add player to roster (skipOwnershipCheck since we validated in canExecuteClaim)
  // Roster size check IS enforced - this is important!
  await mutationService.addPlayerToRoster(
    {
      rosterId: claim.rosterId,
      playerId: claim.playerId,
      leagueId: claim.leagueId,
      acquiredType: 'waiver',
    },
    { skipOwnershipCheck: true }, // Already validated in canExecuteClaim
    client
  );

  // Record add transaction
  await ctx.transactionsRepo.create(
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
    await ctx.faabRepo.deductBudget(claim.rosterId, season, claim.bidAmount, client);
  }

  // Rotate priority for standard waivers
  if (waiverType === 'standard') {
    await ctx.priorityRepo.rotatePriority(claim.leagueId, season, claim.rosterId, client);
  }
}

/**
 * Invalidate pending trades involving a player (called after roster changes)
 * Returns the list of invalidated trades for deferred socket emission
 */
async function invalidateTradesForPlayer(
  ctx: ProcessWaiversContext,
  leagueId: number,
  playerId: number,
  client: PoolClient
): Promise<Array<{ id: number; leagueId: number }>> {
  if (!ctx.tradesRepo) return [];

  // Find pending trades involving this player
  const pendingTrades = await ctx.tradesRepo.findPendingByPlayer(leagueId, playerId, client);
  const invalidatedTrades: Array<{ id: number; leagueId: number }> = [];

  for (const trade of pendingTrades) {
    // Conditional update - only expire if still in pending/accepted/in_review status
    const result = await client.query(
      `UPDATE trades SET status = 'expired', updated_at = NOW()
       WHERE id = $1 AND status IN ('pending', 'accepted', 'in_review')
       RETURNING id`,
      [trade.id]
    );

    // Only add to list if actually updated (was still in eligible status)
    if (result.rowCount && result.rowCount > 0) {
      invalidatedTrades.push({ id: trade.id, leagueId: trade.leagueId });
    }
  }

  return invalidatedTrades;
}

/**
 * Emit trade invalidated event (called after commit)
 */
function emitTradeInvalidated(leagueId: number, tradeId: number): void {
  const eventBus = tryGetEventBus();
  if (!eventBus) return;

  eventBus.publish({
    type: EventTypes.TRADE_INVALIDATED,
    leagueId,
    payload: {
      tradeId,
      reason: 'A player involved in this trade is no longer available',
    },
  });
}

async function emitClaimSuccessful(ctx: ProcessWaiversContext, claim: WaiverClaim): Promise<void> {
  const eventBus = tryGetEventBus();
  if (!eventBus) return;

  const roster = await ctx.rosterRepo.findById(claim.rosterId);
  if (roster && roster.userId) {
    const claimWithDetails = await ctx.claimsRepo.findByIdWithDetails(claim.id);
    if (claimWithDetails) {
      eventBus.publish({
        type: EventTypes.WAIVER_CLAIM_SUCCESSFUL,
        userId: roster.userId,
        payload: waiverClaimToResponse(claimWithDetails),
      });

      // Emit system message to league chat
      if (ctx.eventListenerService) {
        const teamName = roster.settings?.team_name || `Team ${roster.id}`;
        ctx.eventListenerService
          .handleWaiverSuccessful(
            claim.leagueId,
            teamName,
            claimWithDetails.playerName || 'Unknown Player',
            claim.bidAmount > 0 ? claim.bidAmount : undefined
          )
          .catch((err) => logger.warn('Failed to emit system message', {
            type: 'waiver_successful',
            leagueId: claim.leagueId,
            claimId: claim.id,
            error: err.message
          }));
      }
    }
  }
}

async function emitClaimFailed(
  ctx: ProcessWaiversContext,
  claim: WaiverClaim,
  reason: string
): Promise<void> {
  const eventBus = tryGetEventBus();
  if (!eventBus) return;

  const roster = await ctx.rosterRepo.findById(claim.rosterId);
  if (roster && roster.userId) {
    eventBus.publish({
      type: EventTypes.WAIVER_CLAIM_FAILED,
      userId: roster.userId,
      payload: { claimId: claim.id, reason },
    });
  }
}

async function emitPriorityUpdated(
  ctx: ProcessWaiversContext,
  leagueId: number,
  season: number
): Promise<void> {
  const eventBus = tryGetEventBus();
  if (!eventBus) return;

  const priorities = await ctx.priorityRepo.getByLeague(leagueId, season);
  eventBus.publish({
    type: EventTypes.WAIVER_PRIORITY_UPDATED,
    leagueId,
    payload: { priorities: priorities.map(waiverPriorityToResponse) },
  });
}

async function emitBudgetUpdated(
  ctx: ProcessWaiversContext,
  leagueId: number,
  season: number
): Promise<void> {
  const eventBus = tryGetEventBus();
  if (!eventBus) return;

  const budgets = await ctx.faabRepo.getByLeague(leagueId, season);
  eventBus.publish({
    type: EventTypes.WAIVER_BUDGET_UPDATED,
    leagueId,
    payload: { budgets: budgets.map(faabBudgetToResponse) },
  });
}
