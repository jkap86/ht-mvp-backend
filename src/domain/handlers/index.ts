/**
 * Command Handler Registry
 *
 * Centralizes registration of all command handlers with the command bus.
 */

import { CommandBus } from '../command-bus';
import { getDraftCommandHandlers } from './draft-command.handlers';
import { getTradeCommandHandlers } from './trade-command.handlers';
import { getWaiverCommandHandlers } from './waiver-command.handlers';
import { getPlayoffCommandHandlers } from './playoff-command.handlers';
import { logger } from '../../config/logger.config';

/**
 * Register all command handlers with the command bus.
 *
 * @param commandBus - The command bus instance to register handlers with
 */
export function registerAllHandlers(commandBus: CommandBus): void {
  const handlers = [
    ...getDraftCommandHandlers(),
    ...getTradeCommandHandlers(),
    ...getWaiverCommandHandlers(),
    ...getPlayoffCommandHandlers(),
  ];

  commandBus.registerAll(handlers);

  logger.info(`Registered ${handlers.length} command handlers`, {
    commands: commandBus.getRegisteredCommands(),
  });
}

// Re-export individual handler modules
export * from './draft-command.handlers';
export * from './trade-command.handlers';
export * from './waiver-command.handlers';
export * from './playoff-command.handlers';
