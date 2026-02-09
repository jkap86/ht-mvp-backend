/**
 * Trade Command Handlers
 *
 * Handlers for trade-related commands. These handlers wrap the existing
 * trade services and use-case functions.
 */

import { CommandHandler, Command } from '../command-bus';
import {
  CommandTypes,
  TradeProposePayload,
  TradeAcceptPayload,
  TradeRejectPayload,
  TradeCancelPayload,
  TradeCounterPayload,
  TradeVotePayload,
} from '../commands';
import { container, KEYS } from '../../container';
import type { TradesService } from '../../modules/trades/trades.service';

/**
 * Handle TRADE_PROPOSE command - propose a new trade
 */
export class TradeProposeHandler implements CommandHandler<TradeProposePayload> {
  readonly commandType = CommandTypes.TRADE_PROPOSE;

  async handle(command: Command<TradeProposePayload>): Promise<unknown> {
    const tradesService = container.resolve<TradesService>(KEYS.TRADES_SERVICE);

    const userId = command.actor.userId;
    if (!userId) {
      throw new Error('User ID required to propose trade');
    }

    return await tradesService.proposeTrade(
      command.payload.leagueId,
      userId,
      command.payload.recipientRosterId,
      command.payload.proposerItems,
      command.payload.recipientItems,
      command.payload.message
    );
  }
}

/**
 * Handle TRADE_ACCEPT command - accept a pending trade
 */
export class TradeAcceptHandler implements CommandHandler<TradeAcceptPayload> {
  readonly commandType = CommandTypes.TRADE_ACCEPT;

  async handle(command: Command<TradeAcceptPayload>): Promise<unknown> {
    const tradesService = container.resolve<TradesService>(KEYS.TRADES_SERVICE);

    const userId = command.actor.userId;
    if (!userId) {
      throw new Error('User ID required to accept trade');
    }

    return await tradesService.acceptTrade(command.payload.tradeId, userId);
  }
}

/**
 * Handle TRADE_REJECT command - reject a pending trade
 */
export class TradeRejectHandler implements CommandHandler<TradeRejectPayload> {
  readonly commandType = CommandTypes.TRADE_REJECT;

  async handle(command: Command<TradeRejectPayload>): Promise<unknown> {
    const tradesService = container.resolve<TradesService>(KEYS.TRADES_SERVICE);

    const userId = command.actor.userId;
    if (!userId) {
      throw new Error('User ID required to reject trade');
    }

    return await tradesService.rejectTrade(command.payload.tradeId, userId);
  }
}

/**
 * Handle TRADE_CANCEL command - cancel a proposed trade
 */
export class TradeCancelHandler implements CommandHandler<TradeCancelPayload> {
  readonly commandType = CommandTypes.TRADE_CANCEL;

  async handle(command: Command<TradeCancelPayload>): Promise<unknown> {
    const tradesService = container.resolve<TradesService>(KEYS.TRADES_SERVICE);

    const userId = command.actor.userId;
    if (!userId) {
      throw new Error('User ID required to cancel trade');
    }

    return await tradesService.cancelTrade(command.payload.tradeId, userId);
  }
}

/**
 * Handle TRADE_COUNTER command - counter a trade with modifications
 */
export class TradeCounterHandler implements CommandHandler<TradeCounterPayload> {
  readonly commandType = CommandTypes.TRADE_COUNTER;

  async handle(command: Command<TradeCounterPayload>): Promise<unknown> {
    const tradesService = container.resolve<TradesService>(KEYS.TRADES_SERVICE);

    const userId = command.actor.userId;
    if (!userId) {
      throw new Error('User ID required to counter trade');
    }

    return await tradesService.counterTrade(
      command.payload.tradeId,
      userId,
      command.payload.proposerItems,
      command.payload.recipientItems,
      command.payload.message
    );
  }
}

/**
 * Handle TRADE_VOTE command - cast a vote on a trade
 */
export class TradeVoteHandler implements CommandHandler<TradeVotePayload> {
  readonly commandType = CommandTypes.TRADE_VOTE;

  async handle(command: Command<TradeVotePayload>): Promise<unknown> {
    const tradesService = container.resolve<TradesService>(KEYS.TRADES_SERVICE);

    const userId = command.actor.userId;
    if (!userId) {
      throw new Error('User ID required to vote on trade');
    }

    return await tradesService.voteTrade(
      command.payload.tradeId,
      userId,
      command.payload.vote === 'approve'
    );
  }
}

/**
 * Get all trade command handlers for registration.
 */
export function getTradeCommandHandlers(): CommandHandler[] {
  return [
    new TradeProposeHandler(),
    new TradeAcceptHandler(),
    new TradeRejectHandler(),
    new TradeCancelHandler(),
    new TradeCounterHandler(),
    new TradeVoteHandler(),
  ];
}
