/**
 * Trade Command Handlers
 *
 * Wires trade commands to TradesService.
 */

import { CommandHandler } from '../command-bus';
import {
  Command,
  CommandTypes,
  TradeProposePayload,
  TradeAcceptPayload,
  TradeRejectPayload,
  TradeCancelPayload,
  TradeVotePayload,
} from '../commands';
import { container, KEYS } from '../../container';
import type { TradesService } from '../../modules/trades/trades.service';

export class TradeProposeHandler implements CommandHandler<TradeProposePayload> {
  readonly commandType = CommandTypes.TRADE_PROPOSE;

  async handle(command: Command<TradeProposePayload>): Promise<unknown> {
    const { leagueId, recipientRosterId, proposerItems, recipientItems, message } = command.payload;
    const userId = command.actor.userId;
    if (!userId) throw new Error('Trade propose requires a user actor');

    const tradesService = container.resolve<TradesService>(KEYS.TRADES_SERVICE);
    return tradesService.proposeTrade(leagueId, userId, {
      recipientRosterId,
      offeringPlayerIds: proposerItems.filter(i => i.playerId != null).map(i => i.playerId!),
      requestingPlayerIds: recipientItems.filter(i => i.playerId != null).map(i => i.playerId!),
      offeringPickAssetIds: proposerItems.filter(i => i.draftPickAssetId != null).map(i => i.draftPickAssetId!),
      requestingPickAssetIds: recipientItems.filter(i => i.draftPickAssetId != null).map(i => i.draftPickAssetId!),
      message,
    });
  }
}

export class TradeAcceptHandler implements CommandHandler<TradeAcceptPayload> {
  readonly commandType = CommandTypes.TRADE_ACCEPT;

  async handle(command: Command<TradeAcceptPayload>): Promise<unknown> {
    const { tradeId } = command.payload;
    const userId = command.actor.userId;
    if (!userId) throw new Error('Trade accept requires a user actor');

    const tradesService = container.resolve<TradesService>(KEYS.TRADES_SERVICE);
    return tradesService.acceptTrade(tradeId, userId);
  }
}

export class TradeRejectHandler implements CommandHandler<TradeRejectPayload> {
  readonly commandType = CommandTypes.TRADE_REJECT;

  async handle(command: Command<TradeRejectPayload>): Promise<unknown> {
    const { tradeId } = command.payload;
    const userId = command.actor.userId;
    if (!userId) throw new Error('Trade reject requires a user actor');

    const tradesService = container.resolve<TradesService>(KEYS.TRADES_SERVICE);
    return tradesService.rejectTrade(tradeId, userId);
  }
}

export class TradeCancelHandler implements CommandHandler<TradeCancelPayload> {
  readonly commandType = CommandTypes.TRADE_CANCEL;

  async handle(command: Command<TradeCancelPayload>): Promise<unknown> {
    const { tradeId } = command.payload;
    const userId = command.actor.userId;
    if (!userId) throw new Error('Trade cancel requires a user actor');

    const tradesService = container.resolve<TradesService>(KEYS.TRADES_SERVICE);
    return tradesService.cancelTrade(tradeId, userId);
  }
}

export class TradeVoteHandler implements CommandHandler<TradeVotePayload> {
  readonly commandType = CommandTypes.TRADE_VOTE;

  async handle(command: Command<TradeVotePayload>): Promise<unknown> {
    const { tradeId, vote } = command.payload;
    const userId = command.actor.userId;
    if (!userId) throw new Error('Trade vote requires a user actor');

    const tradesService = container.resolve<TradesService>(KEYS.TRADES_SERVICE);
    const serviceVote = vote === 'reject' ? 'veto' as const : vote;
    return tradesService.voteTrade(tradeId, userId, serviceVote);
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
    new TradeVoteHandler(),
  ];
}
