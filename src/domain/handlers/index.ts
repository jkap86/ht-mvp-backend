/**
 * Command Handler Registry
 *
 * Centralizes registration of all command handlers with the command bus.
 *
 * NOTE: Handlers are currently placeholders. Service method signatures need
 * to be aligned before handlers can be properly registered.
 */

import { CommandBus } from '../command-bus';
import { logger } from '../../config/logger.config';

/**
 * Register all command handlers with the command bus.
 *
 * TODO: Implement handlers once service method signatures are aligned.
 * Currently a no-op to allow command bus infrastructure to exist.
 *
 * @param commandBus - The command bus instance to register handlers with
 */
export function registerAllHandlers(commandBus: CommandBus): void {
  // Handlers are placeholders - skip registration for now
  // Once service methods are aligned, uncomment the registration below:
  //
  // const handlers = [
  //   ...getDraftCommandHandlers(),
  //   ...getTradeCommandHandlers(),
  //   ...getWaiverCommandHandlers(),
  //   ...getPlayoffCommandHandlers(),
  // ];
  // commandBus.registerAll(handlers);

  logger.info('Command bus initialized (handlers pending implementation)');
}
