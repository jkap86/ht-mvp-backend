/**
 * Command Handler Registry
 *
 * Centralizes registration of all command handlers with the command bus.
 */

import { CommandBus } from '../command-bus';
import { logger } from '../../../config/logger.config';
import { getDraftCommandHandlers } from './draft-command.handlers';
import { getAuctionCommandHandlers } from './auction-command.handlers';
import { getTradeCommandHandlers } from './trade-command.handlers';
import { getWaiverCommandHandlers } from './waiver-command.handlers';
import { getPlayoffCommandHandlers } from './playoff-command.handlers';

/**
 * Register all command handlers with the command bus.
 *
 * @param commandBus - The command bus instance to register handlers with
 */
export function registerAllHandlers(commandBus: CommandBus): void {
  const handlers = [
    ...getDraftCommandHandlers(),
    ...getAuctionCommandHandlers(),
    ...getTradeCommandHandlers(),
    ...getWaiverCommandHandlers(),
    ...getPlayoffCommandHandlers(),
  ];

  commandBus.registerAll(handlers);

  logger.info(`Command bus initialized with ${handlers.length} handlers`);
}
