/**
 * Trade Command Handlers
 *
 * NOTE: These handlers are PLACEHOLDERS. They are not registered with the
 * command bus until service method signatures are aligned. See handlers/index.ts.
 *
 * TODO: Implement handlers once service methods support the command pattern.
 */

import { CommandHandler } from '../command-bus';
import {
  Command,
  CommandTypes,
  TradeProposePayload,
  TradeAcceptPayload,
  TradeRejectPayload,
  TradeCancelPayload,
  TradeCounterPayload,
  TradeVotePayload,
} from '../commands';

// Placeholder implementations - not currently registered

export class TradeProposeHandler implements CommandHandler<TradeProposePayload> {
  readonly commandType = CommandTypes.TRADE_PROPOSE;

  async handle(_command: Command<TradeProposePayload>): Promise<unknown> {
    throw new Error('Handler not implemented - use TradeService directly');
  }
}

export class TradeAcceptHandler implements CommandHandler<TradeAcceptPayload> {
  readonly commandType = CommandTypes.TRADE_ACCEPT;

  async handle(_command: Command<TradeAcceptPayload>): Promise<unknown> {
    throw new Error('Handler not implemented - use TradeService directly');
  }
}

export class TradeRejectHandler implements CommandHandler<TradeRejectPayload> {
  readonly commandType = CommandTypes.TRADE_REJECT;

  async handle(_command: Command<TradeRejectPayload>): Promise<unknown> {
    throw new Error('Handler not implemented - use TradeService directly');
  }
}

export class TradeCancelHandler implements CommandHandler<TradeCancelPayload> {
  readonly commandType = CommandTypes.TRADE_CANCEL;

  async handle(_command: Command<TradeCancelPayload>): Promise<unknown> {
    throw new Error('Handler not implemented - use TradeService directly');
  }
}

export class TradeCounterHandler implements CommandHandler<TradeCounterPayload> {
  readonly commandType = CommandTypes.TRADE_COUNTER;

  async handle(_command: Command<TradeCounterPayload>): Promise<unknown> {
    throw new Error('Handler not implemented - use TradeService directly');
  }
}

export class TradeVoteHandler implements CommandHandler<TradeVotePayload> {
  readonly commandType = CommandTypes.TRADE_VOTE;

  async handle(_command: Command<TradeVotePayload>): Promise<unknown> {
    throw new Error('Handler not implemented - use TradeService directly');
  }
}

/**
 * Get all trade command handlers for registration.
 * NOTE: Currently returns empty array - handlers are placeholders.
 */
export function getTradeCommandHandlers(): CommandHandler[] {
  return [];
}
