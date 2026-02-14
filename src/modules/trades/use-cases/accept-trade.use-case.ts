import { Pool, PoolClient } from 'pg';
import { TradesRepository, TradeItemsRepository } from '../trades.repository';
import type {
  RosterPlayersRepository,
  RosterTransactionsRepository,
} from '../../rosters/rosters.repository';
import type { RosterMutationService } from '../../rosters/roster-mutation.service';
import type { LeagueRepository, RosterRepository } from '../../leagues/leagues.repository';
import type { DraftPickAssetRepository } from '../../drafts/draft-pick-asset.repository';
import { DomainEventBus, EventTypes, tryGetEventBus } from '../../../shared/events';
import { Trade, TradeWithDetails } from '../trades.model';
import {
  NotFoundException,
  ForbiddenException,
  ValidationException,
  ConflictException,
} from '../../../utils/exceptions';
import { runWithLocks, LockDomain } from '../../../shared/transaction-runner';
import { batchValidateRosterPlayers } from '../../../shared/batch-queries';
import { getMaxRosterSize } from '../../../shared/roster-defaults';
import type { EventListenerService } from '../../chat/event-listener.service';
import { logger } from '../../../config/logger.config';

const DEFAULT_REVIEW_HOURS = 24;

export interface AcceptTradeContext {
  db: Pool;
  tradesRepo: TradesRepository;
  tradeItemsRepo: TradeItemsRepository;
  rosterRepo: RosterRepository;
  rosterPlayersRepo: RosterPlayersRepository;
  transactionsRepo: RosterTransactionsRepository;
  leagueRepo: LeagueRepository;
  pickAssetRepo?: DraftPickAssetRepository;
  eventListenerService?: EventListenerService;
  rosterMutationService: RosterMutationService;
}

/**
 * Accept a trade
 *
 * LOCK CONTRACT:
 * - Acquires ROSTER locks (200M + rosterId) for both participating rosters (sorted order)
 * - Acquires TRADE lock (300M + leagueId) — serializes trade state changes per league
 * - Lock acquisition follows domain priority order (ROSTER before TRADE) to prevent deadlocks
 * - When executing immediately (no review), executeTrade() runs inside these locks
 *
 * Locks are acquired in correct priority order per transactions.md rules.
 */
export async function acceptTrade(
  ctx: AcceptTradeContext,
  tradeId: number,
  userId: string
): Promise<TradeWithDetails> {
  const trade = await ctx.tradesRepo.findById(tradeId);
  if (!trade) throw new NotFoundException('Trade not found');

  // Verify user is recipient
  const roster = await ctx.rosterRepo.findById(trade.recipientRosterId);
  if (!roster || roster.userId !== userId) {
    throw new ForbiddenException('Only the recipient can accept this trade');
  }

  // Allow idempotent retry — if already accepted, return current state without side effects
  if (trade.status === 'accepted' || trade.status === 'completed' || trade.status === 'in_review') {
    const details = await ctx.tradesRepo.findByIdWithDetails(tradeId, roster.id);
    if (!details) throw new NotFoundException('Failed to get trade details');
    return details;
  }
  // Initial status check (will be re-verified inside transaction)
  if (trade.status !== 'pending') {
    throw new ValidationException(`Cannot accept trade with status: ${trade.status}`);
  }

  const league = await ctx.leagueRepo.findById(trade.leagueId);
  if (!league) throw new NotFoundException('League not found');

  // Variables to collect data for event emission after transaction
  // updatedTrade is only set when we actually change state (not on idempotent retry)
  let updatedTrade: Trade | undefined;
  let pickTradedEvents: PickTradedEvent[] = [];

  // Acquire locks in correct domain priority order to prevent deadlocks:
  // 1. ROSTER locks (priority 2) - acquired in sorted order
  // 2. TRADE lock (priority 3)
  const rosterIds = [trade.proposerRosterId, trade.recipientRosterId].sort((a, b) => a - b);
  const locks = [
    ...rosterIds.map((id) => ({ domain: LockDomain.ROSTER, id })),
    { domain: LockDomain.TRADE, id: trade.leagueId },
  ];

  const tradeWithDetails = await runWithLocks(
    ctx.db,
    locks,
    async (client) => {
      // Re-verify status after acquiring lock (another transaction may have changed it)
      const currentTrade = await ctx.tradesRepo.findById(tradeId, client);
      if (!currentTrade) {
        throw new NotFoundException('Trade not found');
      }
      // If already accepted, return current state (idempotent retry)
      if (currentTrade.status === 'accepted') {
        const details = await ctx.tradesRepo.findByIdWithDetails(tradeId, roster.id);
        if (!details) throw new NotFoundException('Failed to get trade details');
        return details;
      }
      // If in another state, cannot accept
      if (currentTrade.status !== 'pending') {
        throw new ValidationException(
          `Cannot accept trade with status: ${currentTrade.status}`
        );
      }

      // Re-check trade deadline (could have passed since proposal)
      const tradeDeadline = league.settings?.trade_deadline;
      if (tradeDeadline && new Date(tradeDeadline) < new Date()) {
        throw new ValidationException('Trade deadline has passed - cannot accept trade');
      }

      // Re-validate all items still valid
      const items = await ctx.tradeItemsRepo.findByTrade(tradeId, client);

      // Separate player and pick items for validation
      const playerItems = items.filter((item) => item.itemType === 'player' && item.playerId);
      const pickItems = items.filter((item) => item.itemType === 'draft_pick' && item.draftPickAssetId);

      // Validate all players using batch query - group by roster
      if (playerItems.length > 0) {
        const playersByRoster = new Map<number, { playerIds: number[]; items: typeof playerItems }>();
        for (const item of playerItems) {
          const existing = playersByRoster.get(item.fromRosterId) || { playerIds: [], items: [] };
          existing.playerIds.push(item.playerId!);
          existing.items.push(item);
          playersByRoster.set(item.fromRosterId, existing);
        }

        for (const [rosterId, { playerIds, items: rosterItems }] of playersByRoster) {
          const validation = await batchValidateRosterPlayers(client, rosterId, playerIds);
          if (validation.missing.length > 0) {
            const missingItem = rosterItems.find((item) => validation.missing.includes(item.playerId!));
            throw new ConflictException(
              `Player ${missingItem?.playerName || validation.missing[0]} is no longer on the expected roster`
            );
          }
        }
      }

      // Validate all picks in parallel
      if (pickItems.length > 0) {
        if (!ctx.pickAssetRepo) {
          throw new ValidationException(
            'Draft pick trading is not configured - pickAssetRepo is required'
          );
        }

        // Fetch all pick assets in parallel
        const pickAssets = await Promise.all(
          pickItems.map((item) => ctx.pickAssetRepo!.findById(item.draftPickAssetId!, client))
        );

        // Check ownership and gather picks that need usage/round checks
        const picksNeedingUsageCheck: Array<{ item: typeof pickItems[0]; pickAsset: NonNullable<typeof pickAssets[0]> }> = [];
        for (let i = 0; i < pickItems.length; i++) {
          const item = pickItems[i];
          const pickAsset = pickAssets[i];
          if (!pickAsset || pickAsset.currentOwnerRosterId !== item.fromRosterId) {
            throw new ConflictException(
              `Draft pick ${item.pickSeason} Round ${item.pickRound} (${item.pickOriginalTeam}'s pick) is no longer owned by the expected roster`
            );
          }
          picksNeedingUsageCheck.push({ item, pickAsset });
        }

        // Check usage status in parallel
        const usageChecks = await Promise.all(
          picksNeedingUsageCheck.map(({ item }) => ctx.pickAssetRepo!.isPickUsed(item.draftPickAssetId!, client))
        );
        const usedIdx = usageChecks.findIndex((isUsed) => isUsed);
        if (usedIdx !== -1) {
          const { item } = picksNeedingUsageCheck[usedIdx];
          throw new ConflictException(
            `Draft pick ${item.pickSeason} Round ${item.pickRound} (${item.pickOriginalTeam}'s pick) has been used`
          );
        }

        // Check round passed status in parallel (only for picks with draftId)
        const picksWithDraft = picksNeedingUsageCheck.filter(({ pickAsset }) => pickAsset.draftId !== null);
        if (picksWithDraft.length > 0) {
          const roundChecks = await Promise.all(
            picksWithDraft.map(({ item }) => ctx.pickAssetRepo!.isRoundPassed(item.draftPickAssetId!, client))
          );
          const roundPassedIdx = roundChecks.findIndex((passed) => passed);
          if (roundPassedIdx !== -1) {
            const { item } = picksWithDraft[roundPassedIdx];
            throw new ConflictException(
              `Draft pick ${item.pickSeason} Round ${item.pickRound} (${item.pickOriginalTeam}'s pick) - round has passed`
            );
          }
        }
      }

      // Check if review is enabled
      const reviewEnabled = league.settings?.trade_review_enabled === true;
      const votingEnabled = league.settings?.trade_voting_enabled === true;

      let result: Trade | null;

      if (reviewEnabled || votingEnabled) {
        // Set review period (conditional - only if still pending)
        const reviewHours = league.settings?.trade_review_hours || DEFAULT_REVIEW_HOURS;
        const reviewStartsAt = new Date();
        const reviewEndsAt = new Date(Date.now() + reviewHours * 60 * 60 * 1000);

        result = await ctx.tradesRepo.setReviewPeriod(
          tradeId,
          reviewStartsAt,
          reviewEndsAt,
          client
        );
        if (!result) {
          throw new ValidationException('Trade status changed during processing');
        }
      } else {
        // Execute immediately - returns events to emit after commit
        pickTradedEvents = await executeTrade(ctx, currentTrade, client);
        result = await ctx.tradesRepo.updateStatus(tradeId, 'completed', client, 'pending');
        if (!result) {
          throw new ValidationException('Trade status changed during processing');
        }
      }

      updatedTrade = result;

      const details = await ctx.tradesRepo.findByIdWithDetails(tradeId, roster.id);
      if (!details) throw new NotFoundException('Failed to get trade details');
      return details;
    }
  );

  // Emit domain events AFTER transaction commits (skip on idempotent retry)
  if (updatedTrade) {
    const eventBus = tryGetEventBus();
    if (eventBus) {
      emitTradeAcceptedEvent(eventBus, trade.leagueId, trade.id, updatedTrade);
      emitPickTradedEvents(eventBus, pickTradedEvents);
    }

    // Emit system message to league chat
    if (ctx.eventListenerService) {
      const isCompleted = updatedTrade.status === 'completed';
      ctx.eventListenerService
        .handleTradeAccepted(trade.leagueId, trade.id, isCompleted, trade.notifyLeagueChat)
        .catch((err) => logger.warn('Failed to emit system message', {
          type: 'trade_accepted',
          leagueId: trade.leagueId,
          tradeId: trade.id,
          error: err.message
        }));
    }
  }

  return tradeWithDetails;
}

/** Pick traded event data for deferred emission after commit */
export interface PickTradedEvent {
  leagueId: number;
  pickAssetId: number;
  season: number;
  round: number;
  previousOwnerRosterId: number;
  newOwnerRosterId: number;
  tradeId: number;
}

/**
 * Execute trade (move players and transfer pick ownership)
 * Returns list of pick traded events to emit AFTER commit
 */
export async function executeTrade(
  ctx: AcceptTradeContext,
  trade: Trade,
  client: PoolClient
): Promise<PickTradedEvent[]> {
  const items = await ctx.tradeItemsRepo.findByTrade(trade.id, client);

  const pickTradedEvents: PickTradedEvent[] = [];

  // Separate player and pick items
  const playerItems = items.filter((item) => item.itemType === 'player' && item.playerId);
  const pickItems = items.filter((item) => item.itemType === 'draft_pick' && item.draftPickAssetId);

  // Get mutation service from context
  const mutationService = ctx.rosterMutationService;

  // Re-validate all picks before any mutations (parallelized for performance)
  if (pickItems.length > 0) {
    if (!ctx.pickAssetRepo) {
      throw new ValidationException(
        'Draft pick trading is not configured - pickAssetRepo is required'
      );
    }
    const pickValidations = await Promise.all(
      pickItems.map((item) => ctx.pickAssetRepo!.findById(item.draftPickAssetId!, client))
    );
    for (let i = 0; i < pickItems.length; i++) {
      const item = pickItems[i];
      const pickAsset = pickValidations[i];
      if (!pickAsset || pickAsset.currentOwnerRosterId !== item.fromRosterId) {
        throw new ConflictException(
          `Draft pick ${item.pickSeason} Round ${item.pickRound} (${item.pickOriginalTeam}'s pick) is no longer available`
        );
      }
    }
  }

  // Execute player movements using atomic single-pass swap
  // CRITICAL: Single-pass atomic update prevents waiver claims from creating duplicate ownership
  // during the gap between remove and add operations.
  if (playerItems.length > 0) {
    // Validate all players exist on expected rosters BEFORE the atomic swap
    // This prevents partial updates if a player was already moved/dropped
    const validationResults = await Promise.all(
      playerItems.map((item) =>
        ctx.rosterPlayersRepo.findByRosterAndPlayer(item.fromRosterId, item.playerId!, client)
      )
    );
    const missingIdx = validationResults.findIndex((result) => !result);
    if (missingIdx !== -1) {
      const item = playerItems[missingIdx];
      throw new ConflictException(
        `Player ${item.playerId} is no longer on roster ${item.fromRosterId} - trade cannot be executed`
      );
    }

    // Validate roster sizes after the trade completes
    // Group players by destination roster to calculate net changes
    const rosterDeltas = new Map<number, number>();
    for (const item of playerItems) {
      // Players leaving (negative delta)
      rosterDeltas.set(item.fromRosterId, (rosterDeltas.get(item.fromRosterId) || 0) - 1);
      // Players arriving (positive delta)
      rosterDeltas.set(item.toRosterId, (rosterDeltas.get(item.toRosterId) || 0) + 1);
    }

    // Check each roster's final size won't exceed max
    const leagueData = await ctx.leagueRepo.findById(trade.leagueId, client);
    if (!leagueData) throw new NotFoundException('League not found');
    const maxRosterSize = getMaxRosterSize(leagueData.settings);

    for (const [rosterId, delta] of rosterDeltas) {
      if (delta > 0) {
        // Roster is receiving more players than it's giving
        const currentSize = await ctx.rosterPlayersRepo.getPlayerCount(rosterId, client);
        const finalSize = currentSize + delta;
        if (finalSize > maxRosterSize) {
          throw new ValidationException(
            `Roster ${rosterId} would exceed max size (${maxRosterSize}). Current: ${currentSize}, would be: ${finalSize}`
          );
        }
      }
    }

    // Build atomic swap using SQL CASE statement
    // This updates all roster_id values in a single atomic operation
    const playerIds = playerItems.map((item) => item.playerId!);
    const fromRosterIds = [...new Set(playerItems.map((item) => item.fromRosterId))];

    // Build WHEN clauses for CASE statement - map each player to its destination roster
    const whenClauses = playerItems.map((item, idx) =>
      `WHEN player_id = $${idx + 1} THEN $${playerIds.length + idx + 1}`
    ).join(' ');

    // Build parameters array: [playerIds..., toRosterIds...]
    const params: number[] = [
      ...playerIds,
      ...playerItems.map((item) => item.toRosterId)
    ];

    // Execute atomic swap - all players move simultaneously, preventing duplicate ownership
    // Defense-in-depth: roster_id filter ensures we only move players from expected rosters
    const swapResult = await client.query(
      `UPDATE roster_players
       SET roster_id = CASE
         ${whenClauses}
       END,
       acquired_type = 'trade'
       WHERE player_id = ANY($${params.length + 1}) AND roster_id = ANY($${params.length + 2})
       RETURNING player_id, roster_id`,
      [...params, playerIds, fromRosterIds]
    );

    // Validate all players were swapped
    if (swapResult.rowCount !== playerItems.length) {
      throw new ConflictException(
        `Trade failed: expected ${playerItems.length} players to move, but only ${swapResult.rowCount} were updated. ` +
        'One or more players may have been traded or dropped.'
      );
    }

    // Record transactions for all player movements
    for (const item of playerItems) {
      const dropTx = await ctx.transactionsRepo.create(
        trade.leagueId,
        item.fromRosterId,
        item.playerId!,
        'trade',
        trade.season,
        trade.week,
        undefined,
        client
      );

      await ctx.transactionsRepo.create(
        trade.leagueId,
        item.toRosterId,
        item.playerId!,
        'trade',
        trade.season,
        trade.week,
        dropTx.id,
        client
      );
    }

    // Auto-remove traded players from their original roster's trade block
    for (const item of playerItems) {
      await client.query(
        'DELETE FROM trade_block_items WHERE roster_id = $1 AND player_id = $2',
        [item.fromRosterId, item.playerId!]
      );
    }
  }

  // Execute pick ownership transfers (collect events for after commit)
  if (pickItems.length > 0) {
    if (!ctx.pickAssetRepo) {
      throw new ValidationException(
        'Draft pick trading is not configured - pickAssetRepo is required'
      );
    }
    for (const item of pickItems) {
      await ctx.pickAssetRepo.transferOwnership(item.draftPickAssetId!, item.toRosterId, client);

      // Collect event for deferred emission after commit
      pickTradedEvents.push({
        leagueId: trade.leagueId,
        pickAssetId: item.draftPickAssetId!,
        season: item.pickSeason!,
        round: item.pickRound!,
        previousOwnerRosterId: item.fromRosterId,
        newOwnerRosterId: item.toRosterId,
        tradeId: trade.id,
      });
    }
  }

  return pickTradedEvents;
}

function emitTradeAcceptedEvent(
  eventBus: DomainEventBus,
  leagueId: number,
  tradeId: number,
  updatedTrade: Trade
): void {
  if (updatedTrade.status === 'completed') {
    eventBus.publish({
      type: EventTypes.TRADE_COMPLETED,
      leagueId,
      payload: { tradeId },
    });
  } else {
    eventBus.publish({
      type: EventTypes.TRADE_ACCEPTED,
      leagueId,
      payload: {
        tradeId,
        reviewEndsAt: updatedTrade.reviewEndsAt,
      },
    });
  }
}

function emitPickTradedEvents(eventBus: DomainEventBus, events: PickTradedEvent[]): void {
  if (events.length === 0) return;
  for (const event of events) {
    eventBus.publish({
      type: EventTypes.PICK_TRADED,
      leagueId: event.leagueId,
      payload: {
        pickAssetId: event.pickAssetId,
        season: event.season,
        round: event.round,
        previousOwnerRosterId: event.previousOwnerRosterId,
        newOwnerRosterId: event.newOwnerRosterId,
        tradeId: event.tradeId,
      },
    });
  }
}
