/**
 * Command Bus Module
 *
 * Re-exports the command bus infrastructure and handler registration.
 */

// Core command bus
export {
  CommandBus,
  CommandHandler,
  CommandResult,
  CommandMiddleware,
  LoggingMiddleware,
  IdempotencyMiddleware,
  IdempotencyError,
  getCommandBus,
  tryGetCommandBus,
  resetCommandBus,
} from './command-bus';

// Handler registration
export { registerAllHandlers } from './handlers';
