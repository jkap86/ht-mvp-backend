import { Pool, PoolClient } from 'pg';
import { TradesRepository, TradeItemsRepository } from '../trades.repository';
import {
  RosterPlayersRepository,
  RosterTransactionsRepository,
} from '../../rosters/rosters.repository';
import { RosterMutationService } from '../../rosters/roster-mutation.service';
import { LeagueRepository, RosterRepository } from '../../leagues/leagues.repository';
import { DraftPickAssetRepository } from '../../drafts/draft-pick-asset.repository';
import { DomainEventBus, EventTypes, tryGetEventBus } from '../../../shared/events';
import { Trade, TradeWithDetails } from '../trades.model';
import {
  NotFoundException,
  ForbiddenException,
  ValidationException,
  ConflictException,
} from '../../../utils/exceptions';
import { runWithLock, LockDomain } from '../../../shared/transaction-runner';
import { batchValidateRosterPlayers } from '../../../shared/batch-queries';
import { EventListenerService } from '../../chat/event-listener.service';
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

  // Initial status check (will be re-verified inside transaction)
  if (trade.status !== 'pending') {
    throw new ValidationException(`Cannot accept trade with status: ${trade.status}`);
  }

  const league = await ctx.leagueRepo.findById(trade.leagueId);
  if (!league) throw new NotFoundException('League not found');

  // Variables to collect data for event emission after transaction
  let updatedTrade!: Trade;
  let pickTradedEvents: PickTradedEvent[] = [];

  const tradeWithDetails = await runWithLock(
    ctx.db,
    LockDomain.TRADE,
    trade.leagueId,
    async (client) => {
      // Re-verify status after acquiring lock (another transaction may have changed it)
      const currentTrade = await ctx.tradesRepo.findById(tradeId, client);
      if (!currentTrade || currentTrade.status !== 'pending') {
        throw new ValidationException(
          `Cannot accept trade with status: ${currentTrade?.status || 'unknown'}`
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
      if (!details) throw new Error('Failed to get trade details');
      return details;
    }
  );

  // Emit domain events AFTER transaction commits
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

  // Execute player movements using two-pass pattern via mutation service
  // CRITICAL: Two-pass execution allows for 1-for-1 swaps even when rosters are full.
  if (playerItems.length > 0) {
    // Pass 1: Remove all players from source rosters to free up space
    // bulkRemovePlayers validates all exist before removing any
    await mutationService.bulkRemovePlayers(
      {
        leagueId: trade.leagueId,
        removals: playerItems.map((item) => ({
          rosterId: item.fromRosterId,
          playerId: item.playerId!,
        })),
      },
      client
    );

    // Pass 2: Add players to destination rosters
    // bulkAddPlayers validates roster size for each add
    await mutationService.bulkAddPlayers(
      {
        leagueId: trade.leagueId,
        additions: playerItems.map((item) => ({
          rosterId: item.toRosterId,
          playerId: item.playerId!,
          acquiredType: 'trade' as const,
        })),
      },
      client
    );

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
