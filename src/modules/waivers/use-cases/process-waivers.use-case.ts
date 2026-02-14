import { PoolClient } from 'pg';
import {
  WaiverClaimsRepository,
  WaiverClaimWithCurrentPriority,
  WaiverProcessingRunsRepository,
} from '../waivers.repository';
import type {
  RosterPlayersRepository,
  RosterTransactionsRepository,
} from '../../rosters/rosters.repository';
import type { RosterMutationService } from '../../rosters/roster-mutation.service';
import type { TradesRepository } from '../../trades/trades.repository';
import { EventTypes, tryGetEventBus } from '../../../shared/events';
import { container, KEYS } from '../../../container';
import { getMaxRosterSize } from '../../../shared/roster-defaults';
import {
  WaiverClaim,
  WaiverType,
  parseWaiverSettings,
  waiverClaimToResponse,
  waiverPriorityToResponse,
  faabBudgetToResponse,
  resolveLeagueCurrentWeek,
} from '../waivers.model';
import { NotFoundException, ConflictException } from '../../../utils/exceptions';
import { runWithLock, LockDomain } from '../../../shared/transaction-runner';
import { addToWaiverWire, WaiverInfoContext } from './waiver-info.use-case';
import { invalidateTradesForPlayer } from '../../trades/trade-invalidation.utils';
import type { EventListenerService } from '../../chat/event-listener.service';
import { logger } from '../../../config/logger.config';

/**
 * In-memory state for a roster during round-based waiver processing.
 * Tracks changes from earlier rounds that affect later claims.
 */
export interface RosterProcessingState {
  rosterId: number;
  currentPriority: number;
  remainingBudget: number;
  currentRosterSize: number;
  /** Set of player IDs currently on roster (updated after adds/drops) */
  ownedPlayerIds: Set<number>;
  /** Set of claim IDs already processed for this roster */
  processedClaimIds: Set<number>;
}

export interface ProcessWaiversContext extends WaiverInfoContext {
  claimsRepo: WaiverClaimsRepository;
  rosterPlayersRepo: RosterPlayersRepository;
  transactionsRepo: RosterTransactionsRepository;
  tradesRepo?: TradesRepository;
  eventListenerService?: EventListenerService;
  rosterMutationService?: RosterMutationService;
  processingRunsRepo?: WaiverProcessingRunsRepository;
}

/**
 * Process waiver claims for a specific league using round-based processing.
 *
 * Round-based algorithm:
 * - Round 1: Take each roster's claim #1, resolve conflicts
 * - Round 2: Take each roster's claim #2 (with updated state from round 1), resolve conflicts
 * - Continue until no more claims
 *
 * This allows chained claims: if a roster's #1 claim wins, their #2 claim
 * uses updated budget/priority/roster composition.
 *
 * LOCK CONTRACT:
 * - Acquires WAIVER lock (400M + leagueId) via runWithLock — serializes all waiver processing per league
 * - All claim resolution, roster mutations, and trade invalidation happen inside this single lock
 * - Trade invalidation uses conditional SQL updates (no TRADE advisory lock) to avoid cross-domain nesting
 *
 * Only one lock domain (WAIVER) is acquired. No nested cross-domain advisory locks.
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

  const maxRosterSize = getMaxRosterSize(league.settings);

  // Collect events to emit AFTER commit to prevent UI desync on rollback
  const pendingEvents: Array<() => void | Promise<void>> = [];

  const { processed, successful } = await runWithLock(
    ctx.db,
    LockDomain.WAIVER,
    leagueId,
    async (client) => {
      // Calculate window start for deduplication (truncate to hour)
      const windowStart = new Date();
      windowStart.setMinutes(0, 0, 0);

      // Create processing run record FIRST to establish snapshot point
      // If a run already exists for this window, we skip processing
      let processingRunId: number | null = null;
      if (ctx.processingRunsRepo) {
        const processingRun = await ctx.processingRunsRepo.tryCreate(
          leagueId,
          season,
          currentWeek,
          windowStart,
          client
        );
        if (!processingRun) {
          logger.debug(`Waiver processing already ran for league ${leagueId} in this window`);
          return { processed: 0, successful: 0 };
        }
        processingRunId = processingRun.id;

        // Snapshot: atomically assign this processing_run_id to all pending claims
        const snapshotCount = await ctx.claimsRepo.snapshotClaimsForProcessingRun(
          leagueId,
          season,
          currentWeek,
          processingRunId,
          client
        );
        logger.debug(`Snapshotted ${snapshotCount} claims for processing run ${processingRunId}`, {
          leagueId,
        });

        if (snapshotCount === 0) {
          logger.debug(`No claims to process, cleaning up processing run ${processingRunId}`, {
            leagueId,
          });
          await ctx.processingRunsRepo.delete(processingRunId, client);
          return { processed: 0, successful: 0 };
        }
      }

      // Get claims to process - either snapshotted claims (if using processing runs)
      // or all pending claims (legacy behavior)
      let allClaims: WaiverClaimWithCurrentPriority[];
      if (processingRunId && ctx.processingRunsRepo) {
        allClaims = await ctx.claimsRepo.getPendingByProcessingRun(processingRunId, client);
      } else {
        allClaims = await ctx.claimsRepo.getPendingByLeagueWithCurrentPriority(
          leagueId,
          season,
          currentWeek,
          client
        );
      }

      if (allClaims.length === 0) {
        if (processingRunId && ctx.processingRunsRepo) {
          await ctx.processingRunsRepo.delete(processingRunId, client);
        }
        return { processed: 0, successful: 0 };
      }

      // Load COMPLETE league ownership (all rosters, not just those with claims)
      // This prevents ConflictException churn when claims target players owned by rosters without claims
      const ownedPlayerIds = await ctx.rosterPlayersRepo.getOwnedPlayerIdsByLeague(
        leagueId,
        client,
        league.activeLeagueSeasonId
      );

      // Initialize roster processing states for rosters that have claims
      const rosterStates = await initializeRosterStates(
        ctx,
        allClaims,
        settings.waiverType,
        season,
        client
      );

      // Group claims by roster, already sorted by claim_order from query
      const claimsByRoster = new Map<number, WaiverClaimWithCurrentPriority[]>();
      for (const claim of allClaims) {
        const existing = claimsByRoster.get(claim.rosterId) || [];
        existing.push(claim);
        claimsByRoster.set(claim.rosterId, existing);
      }

      // Track max priority for rotation — query the real max from ALL league rosters
      let maxPriority = await ctx.priorityRepo.getMaxPriority(leagueId, season, client);
      // Fallback: if no priorities exist yet, use claiming rosters as minimum
      if (maxPriority === 0) {
        for (const state of rosterStates.values()) {
          maxPriority = Math.max(maxPriority, state.currentPriority);
        }
      }

      let processedCount = 0;
      let successfulCount = 0;

      // Process in rounds until no more claims
      let roundNumber = 1;
      while (hasUnprocessedClaims(claimsByRoster, rosterStates)) {
        // Extract active claims for this round (next unprocessed claim from each roster)
        const roundClaims = extractRoundClaims(claimsByRoster, rosterStates);
        if (roundClaims.length === 0) break;

        logger.debug(`Processing waiver round ${roundNumber} with ${roundClaims.length} claims`, {
          leagueId,
        });

        // Group by target player to identify conflicts
        const conflictGroups = new Map<number, WaiverClaimWithCurrentPriority[]>();
        for (const claim of roundClaims) {
          const existing = conflictGroups.get(claim.playerId) || [];
          existing.push(claim);
          conflictGroups.set(claim.playerId, existing);
        }

        // Process each player conflict group
        for (const [playerId, competingClaims] of conflictGroups) {
          // Sort by bid/priority using CURRENT roster state (tracks rotations)
          const sortedClaims = sortClaimsByRosterState(
            competingClaims,
            settings.waiverType,
            rosterStates
          );

          // Find-first-executable: iterate candidates in priority order,
          // try to execute each one until one succeeds or all fail
          let executedWinner: WaiverClaimWithCurrentPriority | null = null;

          for (const claim of sortedClaims) {
            const state = rosterStates.get(claim.rosterId);
            if (!state) continue;

            // Skip if already processed in this round (shouldn't happen, but safety check)
            if (state.processedClaimIds.has(claim.id)) continue;

            // Check if player was already claimed in an earlier round (global ownership)
            if (ownedPlayerIds.has(claim.playerId)) {
              await ctx.claimsRepo.updateStatus(
                claim.id,
                'invalid',
                'Player already owned',
                client
              );
              state.processedClaimIds.add(claim.id);
              processedCount++;
              const claimCopy = { ...claim };
              pendingEvents.push(() => emitClaimFailed(ctx, claimCopy, 'Player already owned'));
              continue; // Try next candidate
            }

            // Validate claim with in-memory state (budget, roster space, drop player)
            const validation = validateClaimWithState(
              claim,
              state,
              settings.waiverType,
              maxRosterSize
            );

            if (!validation.eligible) {
              // Mark invalid and continue to next candidate
              await ctx.claimsRepo.updateStatus(claim.id, 'invalid', validation.reason, client);
              state.processedClaimIds.add(claim.id);
              processedCount++;
              const claimCopy = { ...claim };
              const reason = validation.reason || 'Invalid claim';
              pendingEvents.push(() => emitClaimFailed(ctx, claimCopy, reason));
              continue; // Try next candidate
            }

            // Attempt to execute this claim
            try {
              await executeClaim(ctx, claim, settings.waiverType, season, client);
              await ctx.claimsRepo.updateStatus(claim.id, 'successful', undefined, client);
              successfulCount++;
              processedCount++;

              // Update global ownership tracking
              ownedPlayerIds.add(claim.playerId);
              if (claim.dropPlayerId) {
                ownedPlayerIds.delete(claim.dropPlayerId);
              }

              // Update in-memory state for this roster's future claims
              updateRosterStateAfterWin(
                state,
                claim,
                settings.waiverType,
                rosterStates,
                maxPriority
              );

              state.processedClaimIds.add(claim.id);

              // Queue success emit
              const claimCopy = { ...claim };
              pendingEvents.push(() => emitClaimSuccessful(ctx, claimCopy));

              // Remove player from waiver wire
              await ctx.waiverWireRepo.removePlayer(
                leagueId,
                playerId,
                client,
                league.activeLeagueSeasonId
              );

              // Invalidate pending trades
              if (ctx.tradesRepo) {
                const invalidatedTrades = await invalidateTradesForPlayer(
                  ctx.tradesRepo,
                  leagueId,
                  playerId,
                  client
                );
                for (const trade of invalidatedTrades) {
                  pendingEvents.push(() => emitTradeInvalidated(trade.leagueId, trade.id));
                }
                if (claim.dropPlayerId) {
                  const droppedPlayerTrades = await invalidateTradesForPlayer(
                    ctx.tradesRepo,
                    leagueId,
                    claim.dropPlayerId,
                    client
                  );
                  for (const trade of droppedPlayerTrades) {
                    pendingEvents.push(() => emitTradeInvalidated(trade.leagueId, trade.id));
                  }
                }
              }

              // Mark this claim as the executed winner and stop trying candidates
              executedWinner = claim;
              break;
            } catch (error) {
              // Handle ownership conflict from addPlayerToRoster
              if (
                error instanceof ConflictException &&
                error.message.includes('already on a roster')
              ) {
                await ctx.claimsRepo.updateStatus(
                  claim.id,
                  'invalid',
                  'Player already owned',
                  client
                );
                processedCount++;
                state.processedClaimIds.add(claim.id);
                const claimCopy = { ...claim };
                pendingEvents.push(() => emitClaimFailed(ctx, claimCopy, 'Player already owned'));
                // NOTE: Do NOT add to ownedPlayerIds here - let the next candidate try.
                // Each candidate might have different ownership context (e.g., the player might
                // be on a roster that the next candidate could still acquire from).
                // Only add to ownedPlayerIds on SUCCESS (line above).
                continue;
              }

              // Catch unexpected errors to prevent one bad claim from rolling back the whole league
              logger.error(`Error processing waiver claim ${claim.id}`, error);
              await ctx.claimsRepo.updateStatus(
                claim.id,
                'failed',
                'System error during processing',
                client
              );
              processedCount++;
              state.processedClaimIds.add(claim.id);
              const claimCopy = { ...claim };
              pendingEvents.push(() =>
                emitClaimFailed(ctx, claimCopy, 'System error during processing')
              );
              continue;
            }
          }

          // Mark remaining unprocessed claims in this conflict group as losers
          for (const claim of sortedClaims) {
            const state = rosterStates.get(claim.rosterId);
            if (!state) continue;

            // Skip already processed claims (winner, invalid, or ownership conflicts)
            if (state.processedClaimIds.has(claim.id)) continue;

            // Determine failure reason based on whether anyone won
            let reason: string;
            if (executedWinner) {
              reason = 'Outbid by another team';
            } else {
              const validation = validateClaimWithState(
                claim,
                state,
                settings.waiverType,
                maxRosterSize
              );
              reason = validation.reason || 'No eligible claimers';
            }
            await ctx.claimsRepo.updateStatus(claim.id, 'failed', reason, client);
            processedCount++;
            state.processedClaimIds.add(claim.id);

            const claimCopy = { ...claim };
            pendingEvents.push(() => emitClaimFailed(ctx, claimCopy, reason));
          }
        }

        roundNumber++;
      }

      // Update processing run with results
      if (processingRunId && ctx.processingRunsRepo) {
        await ctx.processingRunsRepo.updateResults(
          processingRunId,
          processedCount,
          successfulCount,
          client
        );
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
    ctx.eventListenerService.handleWaiverProcessed(leagueId).catch((err) =>
      logger.warn('Failed to emit system message', {
        type: 'waiver_processed',
        leagueId,
        error: err.message,
      })
    );
  }

  return { processed, successful };
}

/**
 * Initialize in-memory roster states for processing.
 * Loads current priority, budget, and roster composition for each roster with claims.
 * Note: Global ownership is now loaded separately via getOwnedPlayerIdsByLeague().
 */
async function initializeRosterStates(
  ctx: ProcessWaiversContext,
  claims: WaiverClaimWithCurrentPriority[],
  waiverType: WaiverType,
  season: number,
  client: PoolClient
): Promise<Map<number, RosterProcessingState>> {
  const states = new Map<number, RosterProcessingState>();
  const rosterIds = [...new Set(claims.map((c) => c.rosterId))];

  for (const rosterId of rosterIds) {
    // Get current priority from the first claim for this roster (all have same currentPriority)
    const claimForRoster = claims.find((c) => c.rosterId === rosterId);
    const currentPriority = claimForRoster?.currentPriority ?? Infinity;

    // Get FAAB budget
    let remainingBudget = 0;
    if (waiverType === 'faab') {
      const budget = await ctx.faabRepo.getByRoster(rosterId, season, client);
      remainingBudget = budget?.remainingBudget ?? 0;
    }

    // Get current roster composition for this roster
    const playerIds = await ctx.rosterPlayersRepo.getPlayerIdsByRoster(rosterId, client);
    const rosterOwnedPlayerIds = new Set(playerIds);

    states.set(rosterId, {
      rosterId,
      currentPriority,
      remainingBudget,
      currentRosterSize: playerIds.length,
      ownedPlayerIds: rosterOwnedPlayerIds,
      processedClaimIds: new Set(),
    });
  }

  return states;
}

/**
 * Check if any roster has unprocessed claims remaining.
 */
function hasUnprocessedClaims(
  claimsByRoster: Map<number, WaiverClaimWithCurrentPriority[]>,
  rosterStates: Map<number, RosterProcessingState>
): boolean {
  for (const [rosterId, claims] of claimsByRoster) {
    const state = rosterStates.get(rosterId);
    if (!state) continue;

    const hasUnprocessed = claims.some((c) => !state.processedClaimIds.has(c.id));
    if (hasUnprocessed) return true;
  }
  return false;
}

/**
 * Extract the next unprocessed claim from each roster for this round.
 * Claims are already sorted by claim_order from the query, so we just find
 * the first one that hasn't been processed yet.
 */
function extractRoundClaims(
  claimsByRoster: Map<number, WaiverClaimWithCurrentPriority[]>,
  rosterStates: Map<number, RosterProcessingState>
): WaiverClaimWithCurrentPriority[] {
  const roundClaims: WaiverClaimWithCurrentPriority[] = [];

  for (const [rosterId, claims] of claimsByRoster) {
    const state = rosterStates.get(rosterId);
    if (!state) continue;

    // Find the next claim that hasn't been processed (by ID)
    const nextClaim = claims.find((c) => !state.processedClaimIds.has(c.id));
    if (nextClaim) {
      roundClaims.push(nextClaim);
    }
  }

  return roundClaims;
}

/**
 * Compare two waiver claims for sorting priority.
 *
 * Tie-break hierarchy:
 *   FAAB:     bid DESC → priority ASC → timestamp ASC → claim ID ASC
 *   Standard: priority ASC → timestamp ASC → claim ID ASC
 *
 * Returns negative if `a` wins (sorts first), positive if `b` wins.
 */
export function compareClaims(
  a: WaiverClaimWithCurrentPriority,
  b: WaiverClaimWithCurrentPriority,
  waiverType: WaiverType,
  rosterStates: Map<number, RosterProcessingState>
): number {
  const aPriority = rosterStates.get(a.rosterId)?.currentPriority ?? Infinity;
  const bPriority = rosterStates.get(b.rosterId)?.currentPriority ?? Infinity;

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
  const timeDiff = a.createdAt.getTime() - b.createdAt.getTime();
  if (timeDiff !== 0) return timeDiff;
  // Deterministic tie-breaker for same-millisecond claims
  return a.id - b.id;
}

/**
 * Sort claims by current roster state (priority/bid).
 * Uses in-memory state that reflects rotations from earlier rounds.
 */
function sortClaimsByRosterState(
  claims: WaiverClaimWithCurrentPriority[],
  waiverType: WaiverType,
  rosterStates: Map<number, RosterProcessingState>
): WaiverClaimWithCurrentPriority[] {
  return [...claims].sort((a, b) => compareClaims(a, b, waiverType, rosterStates));
}

/**
 * Validate a claim using in-memory roster state.
 * Returns eligibility and failure reason if not eligible.
 */
function validateClaimWithState(
  claim: WaiverClaimWithCurrentPriority,
  state: RosterProcessingState,
  waiverType: WaiverType,
  maxRosterSize: number
): { eligible: boolean; reason?: string } {
  // Check if player is already owned (by any roster in current state)
  // Note: We can't check other rosters' state easily here, but we do DB check in executeClaim
  // For in-memory validation, we check budget/roster constraints

  // Check if player is already on this roster (from a previous round win)
  if (state.ownedPlayerIds.has(claim.playerId)) {
    return { eligible: false, reason: 'Player already on your roster' };
  }

  // Check if drop player is still on roster
  if (claim.dropPlayerId && !state.ownedPlayerIds.has(claim.dropPlayerId)) {
    return { eligible: false, reason: 'Drop player no longer on roster' };
  }

  // Check roster space
  if (!claim.dropPlayerId && state.currentRosterSize >= maxRosterSize) {
    return { eligible: false, reason: 'Roster is full' };
  }

  // Check FAAB budget
  if (waiverType === 'faab' && claim.bidAmount > 0) {
    if (state.remainingBudget < claim.bidAmount) {
      return {
        eligible: false,
        reason: `Insufficient FAAB budget ($${state.remainingBudget} available)`,
      };
    }
  }

  return { eligible: true };
}

/**
 * Update roster state after a successful claim.
 * This affects subsequent claims from the same roster.
 */
function updateRosterStateAfterWin(
  state: RosterProcessingState,
  claim: WaiverClaim,
  waiverType: WaiverType,
  allStates: Map<number, RosterProcessingState>,
  maxPriority: number
): void {
  // Update roster composition
  state.ownedPlayerIds.add(claim.playerId);
  if (claim.dropPlayerId) {
    state.ownedPlayerIds.delete(claim.dropPlayerId);
    // Size stays same when dropping
  } else {
    state.currentRosterSize++;
  }

  // Deduct FAAB budget
  if (waiverType === 'faab' && claim.bidAmount > 0) {
    state.remainingBudget -= claim.bidAmount;
  }

  // Rotate priority for standard waivers
  if (waiverType === 'standard') {
    const winnerOldPriority = state.currentPriority;
    // Shift everyone who was behind the winner up by 1
    for (const [, otherState] of allStates) {
      if (otherState.currentPriority > winnerOldPriority) {
        otherState.currentPriority--;
      }
    }
    // Winner goes to last place (max priority)
    state.currentPriority = maxPriority;
  }
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
    ctx.rosterMutationService ??
    container.resolve<RosterMutationService>(KEYS.ROSTER_MUTATION_SERVICE);

  // Drop player first if specified
  if (claim.dropPlayerId) {
    try {
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
    } catch (err) {
      // Player was already dropped manually - log warning and continue
      // This handles the TOCTOU race where a player is dropped between claim submission and processing
      if (err instanceof NotFoundException) {
        logger.warn(
          'Drop player not found during waiver processing - may have been dropped manually',
          {
            claimId: claim.id,
            rosterId: claim.rosterId,
            dropPlayerId: claim.dropPlayerId,
            error: err.message,
          }
        );
        // Continue without drop - the claim will still be processed
      } else {
        // For other errors, re-throw
        throw err;
      }
    }
  }

  // Add player to roster - ownership is validated in-memory before this call,
  // but we also let the DB validate to catch any race conditions.
  // Roster size check IS enforced - this is important!
  await mutationService.addPlayerToRoster(
    {
      rosterId: claim.rosterId,
      playerId: claim.playerId,
      leagueId: claim.leagueId,
      acquiredType: 'waiver',
    },
    {}, // Let DB validate ownership - caller handles ConflictException
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
          .catch((err) =>
            logger.warn('Failed to emit system message', {
              type: 'waiver_successful',
              leagueId: claim.leagueId,
              claimId: claim.id,
              error: err.message,
            })
          );
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
