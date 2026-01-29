import { PoolClient } from 'pg';
import { WaiverClaimsRepository } from '../waivers.repository';
import {
  RosterPlayersRepository,
  RosterTransactionsRepository,
} from '../../rosters/rosters.repository';
import { TradesRepository } from '../../trades/trades.repository';
import { tryGetSocketService } from '../../../socket';
import {
  WaiverClaim,
  WaiverType,
  parseWaiverSettings,
  waiverClaimToResponse,
  waiverPriorityToResponse,
  faabBudgetToResponse,
} from '../waivers.model';
import { NotFoundException } from '../../../utils/exceptions';
import { getWaiverLockId } from '../../../utils/locks';
import { addToWaiverWire, WaiverInfoContext } from './waiver-info.use-case';

export interface ProcessWaiversContext extends WaiverInfoContext {
  claimsRepo: WaiverClaimsRepository;
  rosterPlayersRepo: RosterPlayersRepository;
  transactionsRepo: RosterTransactionsRepository;
  tradesRepo?: TradesRepository;
}

/**
 * Process waiver claims for a specific league
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

  const client = await ctx.db.connect();
  let processed = 0;
  let successful = 0;

  // Collect events to emit AFTER commit to prevent UI desync on rollback
  const pendingEvents: Array<() => void | Promise<void>> = [];

  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [getWaiverLockId(leagueId)]);

    // Get all pending claims grouped by player
    const pendingClaims = await ctx.claimsRepo.getPendingByLeague(leagueId, client);

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
      const sortedClaims = sortClaimsByPriority(claims, settings.waiverType);

      let winner: WaiverClaim | null = null;

      // Find first eligible winner
      for (const claim of sortedClaims) {
        const canExecute = await canExecuteClaim(ctx, claim, settings.waiverType, season, client);
        if (canExecute) {
          winner = claim;
          break;
        }
      }

      // Execute winner, fail others
      for (const claim of sortedClaims) {
        processed++;

        if (winner && claim.id === winner.id) {
          await executeClaim(ctx, claim, settings.waiverType, season, client);
          await ctx.claimsRepo.updateStatus(claim.id, 'successful', undefined, client);
          successful++;

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

    await client.query('COMMIT');

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
function sortClaimsByPriority(claims: WaiverClaim[], waiverType: WaiverType): WaiverClaim[] {
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
async function canExecuteClaim(
  ctx: ProcessWaiversContext,
  claim: WaiverClaim,
  waiverType: WaiverType,
  season: number,
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
    const league = await ctx.leagueRepo.findById(claim.leagueId);
    if (!league) return false;

    const rosterSize = await ctx.rosterPlayersRepo.getPlayerCount(claim.rosterId, client);
    const maxSize = league.settings?.roster_size || 15;
    if (rosterSize >= maxSize) return false;
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
  // Drop player first if specified
  if (claim.dropPlayerId) {
    await ctx.rosterPlayersRepo.removePlayer(claim.rosterId, claim.dropPlayerId, client);

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

  // Add player to roster
  await ctx.rosterPlayersRepo.addPlayer(claim.rosterId, claim.playerId, 'waiver', client);

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
  const pendingTrades = await ctx.tradesRepo.findPendingByPlayer(leagueId, playerId);
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
  const socket = tryGetSocketService();
  socket?.emitTradeInvalidated(leagueId, {
    tradeId,
    reason: 'A player involved in this trade is no longer available',
  });
}

async function emitClaimSuccessful(ctx: ProcessWaiversContext, claim: WaiverClaim): Promise<void> {
  const roster = await ctx.rosterRepo.findById(claim.rosterId);
  if (roster && roster.userId) {
    const socket = tryGetSocketService();
    const claimWithDetails = await ctx.claimsRepo.findByIdWithDetails(claim.id);
    if (claimWithDetails) {
      socket?.emitWaiverClaimSuccessful(roster.userId, waiverClaimToResponse(claimWithDetails));
    }
  }
}

async function emitClaimFailed(
  ctx: ProcessWaiversContext,
  claim: WaiverClaim,
  reason: string
): Promise<void> {
  const roster = await ctx.rosterRepo.findById(claim.rosterId);
  if (roster && roster.userId) {
    const socket = tryGetSocketService();
    socket?.emitWaiverClaimFailed(roster.userId, { claimId: claim.id, reason });
  }
}

async function emitPriorityUpdated(
  ctx: ProcessWaiversContext,
  leagueId: number,
  season: number
): Promise<void> {
  const priorities = await ctx.priorityRepo.getByLeague(leagueId, season);
  const socket = tryGetSocketService();
  socket?.emitWaiverPriorityUpdated(leagueId, priorities.map(waiverPriorityToResponse));
}

async function emitBudgetUpdated(
  ctx: ProcessWaiversContext,
  leagueId: number,
  season: number
): Promise<void> {
  const budgets = await ctx.faabRepo.getByLeague(leagueId, season);
  const socket = tryGetSocketService();
  socket?.emitWaiverBudgetUpdated(leagueId, budgets.map(faabBudgetToResponse));
}
