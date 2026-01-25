import { Pool, PoolClient } from 'pg';
import { TradesRepository, TradeItemsRepository } from '../trades.repository';
import { RosterPlayersRepository, RosterTransactionsRepository } from '../../rosters/rosters.repository';
import { LeagueRepository, RosterRepository } from '../../leagues/leagues.repository';
import { getSocketService } from '../../../socket';
import { Trade, TradeWithDetails } from '../trades.model';
import {
  NotFoundException,
  ForbiddenException,
  ValidationException,
  ConflictException,
} from '../../../utils/exceptions';
import { getTradeLockId } from '../../../utils/locks';

const DEFAULT_REVIEW_HOURS = 24;

export interface AcceptTradeContext {
  db: Pool;
  tradesRepo: TradesRepository;
  tradeItemsRepo: TradeItemsRepository;
  rosterRepo: RosterRepository;
  rosterPlayersRepo: RosterPlayersRepository;
  transactionsRepo: RosterTransactionsRepository;
  leagueRepo: LeagueRepository;
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
      throw new ValidationException(`Cannot accept trade with status: ${currentTrade?.status || 'unknown'}`);
    }

    // Re-validate all players still on correct rosters
    const items = await ctx.tradeItemsRepo.findByTrade(tradeId);
    for (const item of items) {
      const onRoster = await ctx.rosterPlayersRepo.findByRosterAndPlayer(
        item.fromRosterId,
        item.playerId,
        client
      );
      if (!onRoster) {
        throw new ConflictException(`Player ${item.playerName} is no longer on the expected roster`);
      }
    }

    // Check if review is enabled
    const reviewEnabled = league.settings?.trade_review_enabled === true;
    const votingEnabled = league.settings?.trade_voting_enabled === true;

    let updatedTrade: Trade | null;

    if (reviewEnabled || votingEnabled) {
      // Set review period (conditional - only if still pending)
      const reviewHours = league.settings?.trade_review_hours || DEFAULT_REVIEW_HOURS;
      const reviewStartsAt = new Date();
      const reviewEndsAt = new Date(Date.now() + reviewHours * 60 * 60 * 1000);

      updatedTrade = await ctx.tradesRepo.setReviewPeriod(tradeId, reviewStartsAt, reviewEndsAt, client);
      if (!updatedTrade) {
        throw new ValidationException('Trade status changed during processing');
      }
    } else {
      // Execute immediately
      await executeTrade(ctx, currentTrade, client);
      updatedTrade = await ctx.tradesRepo.updateStatus(tradeId, 'completed', client, 'pending');
      if (!updatedTrade) {
        throw new ValidationException('Trade status changed during processing');
      }
    }

    await client.query('COMMIT');

    const tradeWithDetails = await ctx.tradesRepo.findByIdWithDetails(tradeId, roster.id);
    if (!tradeWithDetails) throw new Error('Failed to get trade details');

    // Emit socket event
    emitTradeAcceptedEvent(trade.leagueId, trade.id, updatedTrade);

    return tradeWithDetails;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Execute trade (move players)
 */
export async function executeTrade(
  ctx: AcceptTradeContext,
  trade: Trade,
  client: PoolClient
): Promise<void> {
  const items = await ctx.tradeItemsRepo.findByTrade(trade.id);

  // Re-validate all players
  for (const item of items) {
    const onRoster = await ctx.rosterPlayersRepo.findByRosterAndPlayer(
      item.fromRosterId,
      item.playerId,
      client
    );
    if (!onRoster) {
      throw new ConflictException(`Player ${item.playerName} is no longer available`);
    }
  }

  // Execute movements
  for (const item of items) {
    // Remove from source
    await ctx.rosterPlayersRepo.removePlayer(item.fromRosterId, item.playerId, client);

    // Add to destination
    await ctx.rosterPlayersRepo.addPlayer(item.toRosterId, item.playerId, 'trade', client);

    // Record transactions
    const dropTx = await ctx.transactionsRepo.create(
      trade.leagueId,
      item.fromRosterId,
      item.playerId,
      'trade',
      trade.season,
      trade.week,
      undefined,
      client
    );

    await ctx.transactionsRepo.create(
      trade.leagueId,
      item.toRosterId,
      item.playerId,
      'trade',
      trade.season,
      trade.week,
      dropTx.id,
      client
    );
  }
}

function emitTradeAcceptedEvent(leagueId: number, tradeId: number, updatedTrade: Trade): void {
  try {
    const socket = getSocketService();
    if (updatedTrade.status === 'completed') {
      socket.emitTradeCompleted(leagueId, { tradeId });
    } else {
      socket.emitTradeAccepted(leagueId, {
        tradeId,
        reviewEndsAt: updatedTrade.reviewEndsAt,
      });
    }
  } catch (socketError) {
    console.warn('Failed to emit trade event:', socketError);
  }
}
