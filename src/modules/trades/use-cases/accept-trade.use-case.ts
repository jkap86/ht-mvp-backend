import { Pool, PoolClient } from 'pg';
import { TradesRepository, TradeItemsRepository } from '../trades.repository';
import {
  RosterPlayersRepository,
  RosterTransactionsRepository,
} from '../../rosters/rosters.repository';
import { LeagueRepository, RosterRepository } from '../../leagues/leagues.repository';
import { DraftPickAssetRepository } from '../../drafts/draft-pick-asset.repository';
import { tryGetSocketService } from '../../../socket';
import { Trade, TradeWithDetails } from '../trades.model';
import {
  NotFoundException,
  ForbiddenException,
  ValidationException,
  ConflictException,
} from '../../../utils/exceptions';
import { getTradeLockId } from '../../../utils/locks';
import { EventListenerService } from '../../chat/event-listener.service';

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

  const client = await ctx.db.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [getTradeLockId(trade.leagueId)]);

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
    const items = await ctx.tradeItemsRepo.findByTrade(tradeId);
    for (const item of items) {
      if (item.itemType === 'player' && item.playerId) {
        const onRoster = await ctx.rosterPlayersRepo.findByRosterAndPlayer(
          item.fromRosterId,
          item.playerId,
          client
        );
        if (!onRoster) {
          throw new ConflictException(
            `Player ${item.playerName} is no longer on the expected roster`
          );
        }
      } else if (item.itemType === 'draft_pick' && item.draftPickAssetId) {
        // Ensure pickAssetRepo is available for draft pick validation
        if (!ctx.pickAssetRepo) {
          throw new ValidationException(
            'Draft pick trading is not configured - pickAssetRepo is required'
          );
        }
        // Validate pick is still owned by expected roster and tradeable
        const pickAsset = await ctx.pickAssetRepo.findById(item.draftPickAssetId, client);
        if (!pickAsset || pickAsset.currentOwnerRosterId !== item.fromRosterId) {
          throw new ConflictException(
            `Draft pick ${item.pickSeason} Round ${item.pickRound} (${item.pickOriginalTeam}'s pick) is no longer owned by the expected roster`
          );
        }

        // Check if pick is still tradeable (not used, round not passed)
        const isUsed = await ctx.pickAssetRepo.isPickUsed(item.draftPickAssetId, client);
        if (isUsed) {
          throw new ConflictException(
            `Draft pick ${item.pickSeason} Round ${item.pickRound} (${item.pickOriginalTeam}'s pick) has been used`
          );
        }

        if (pickAsset.draftId !== null) {
          const roundPassed = await ctx.pickAssetRepo.isRoundPassed(item.draftPickAssetId, client);
          if (roundPassed) {
            throw new ConflictException(
              `Draft pick ${item.pickSeason} Round ${item.pickRound} (${item.pickOriginalTeam}'s pick) - round has passed`
            );
          }
        }
      }
    }

    // Check if review is enabled
    const reviewEnabled = league.settings?.trade_review_enabled === true;
    const votingEnabled = league.settings?.trade_voting_enabled === true;

    let updatedTrade: Trade | null;
    let pickTradedEvents: PickTradedEvent[] = [];

    if (reviewEnabled || votingEnabled) {
      // Set review period (conditional - only if still pending)
      const reviewHours = league.settings?.trade_review_hours || DEFAULT_REVIEW_HOURS;
      const reviewStartsAt = new Date();
      const reviewEndsAt = new Date(Date.now() + reviewHours * 60 * 60 * 1000);

      updatedTrade = await ctx.tradesRepo.setReviewPeriod(
        tradeId,
        reviewStartsAt,
        reviewEndsAt,
        client
      );
      if (!updatedTrade) {
        throw new ValidationException('Trade status changed during processing');
      }
    } else {
      // Execute immediately - returns events to emit after commit
      pickTradedEvents = await executeTrade(ctx, currentTrade, client);
      updatedTrade = await ctx.tradesRepo.updateStatus(tradeId, 'completed', client, 'pending');
      if (!updatedTrade) {
        throw new ValidationException('Trade status changed during processing');
      }
    }

    await client.query('COMMIT');

    const tradeWithDetails = await ctx.tradesRepo.findByIdWithDetails(tradeId, roster.id);
    if (!tradeWithDetails) throw new Error('Failed to get trade details');

    // Emit socket events AFTER commit
    emitTradeAcceptedEvent(trade.leagueId, trade.id, updatedTrade);
    emitPickTradedEvents(pickTradedEvents);

    // Emit system message to league chat
    if (ctx.eventListenerService) {
      const isCompleted = updatedTrade.status === 'completed';
      ctx.eventListenerService
        .handleTradeAccepted(trade.leagueId, trade.id, isCompleted, trade.notifyLeagueChat)
        .catch((err) => console.error('Failed to emit trade accepted system message:', err));
    }

    return tradeWithDetails;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
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
  const items = await ctx.tradeItemsRepo.findByTrade(trade.id);

  const league = await ctx.leagueRepo.findById(trade.leagueId);
  const maxRosterSize = league?.settings?.roster_size || 15;

  const pickTradedEvents: PickTradedEvent[] = [];

  // Separate player and pick items
  const playerItems = items.filter((item) => item.itemType === 'player' && item.playerId);
  const pickItems = items.filter((item) => item.itemType === 'draft_pick' && item.draftPickAssetId);

  // Re-validate all players
  for (const item of playerItems) {
    const onRoster = await ctx.rosterPlayersRepo.findByRosterAndPlayer(
      item.fromRosterId,
      item.playerId!,
      client
    );
    if (!onRoster) {
      throw new ConflictException(`Player ${item.playerName} is no longer available`);
    }
  }

  // Re-validate all picks
  if (pickItems.length > 0) {
    if (!ctx.pickAssetRepo) {
      throw new ValidationException(
        'Draft pick trading is not configured - pickAssetRepo is required'
      );
    }
    for (const item of pickItems) {
      const pickAsset = await ctx.pickAssetRepo.findById(item.draftPickAssetId!, client);
      if (!pickAsset || pickAsset.currentOwnerRosterId !== item.fromRosterId) {
        throw new ConflictException(
          `Draft pick ${item.pickSeason} Round ${item.pickRound} (${item.pickOriginalTeam}'s pick) is no longer available`
        );
      }
    }
  }

  // Execute player movements
  // CRITICAL: Two-pass execution allows for 1-for-1 swaps even when rosters are full.
  // Pass 1: Remove all players from source rosters to free up space.
  for (const item of playerItems) {
    await ctx.rosterPlayersRepo.removePlayer(item.fromRosterId, item.playerId!, client);
  }

  // Second pass: Add players to destination rosters and record transactions
  for (const item of playerItems) {
    // Validate Roster Limits
    // Note: rosterSize here reflects the count AFTER removals from Pass 1
    const rosterSize = await ctx.rosterPlayersRepo.getPlayerCount(item.toRosterId, client);
    if (rosterSize >= maxRosterSize) {
      throw new ValidationException(
        `Roster is full. Cannot add player to roster ${item.toRosterId}.`
      );
    }

    // Add to destination
    await ctx.rosterPlayersRepo.addPlayer(item.toRosterId, item.playerId!, 'trade', client);

    // Record transactions
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

function emitTradeAcceptedEvent(leagueId: number, tradeId: number, updatedTrade: Trade): void {
  const socket = tryGetSocketService();
  if (updatedTrade.status === 'completed') {
    socket?.emitTradeCompleted(leagueId, { tradeId });
  } else {
    socket?.emitTradeAccepted(leagueId, {
      tradeId,
      reviewEndsAt: updatedTrade.reviewEndsAt,
    });
  }
}

function emitPickTradedEvents(events: PickTradedEvent[]): void {
  if (events.length === 0) return;
  const socket = tryGetSocketService();
  for (const event of events) {
    socket?.emitPickTraded(event.leagueId, {
      pickAssetId: event.pickAssetId,
      season: event.season,
      round: event.round,
      previousOwnerRosterId: event.previousOwnerRosterId,
      newOwnerRosterId: event.newOwnerRosterId,
      tradeId: event.tradeId,
    });
  }
}
