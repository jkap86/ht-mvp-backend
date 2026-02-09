/**
 * Playoff Command Handlers
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
  PlayoffGenerateBracketPayload,
  PlayoffAdvanceWinnersPayload,
  PlayoffFinalizePayload,
} from '../commands';

// Placeholder implementations - not currently registered

export class PlayoffGenerateBracketHandler implements CommandHandler<PlayoffGenerateBracketPayload> {
  readonly commandType = CommandTypes.PLAYOFF_GENERATE_BRACKET;

  async handle(_command: Command<PlayoffGenerateBracketPayload>): Promise<unknown> {
    throw new Error('Handler not implemented - use PlayoffService directly');
  }
}

export class PlayoffAdvanceWinnersHandler implements CommandHandler<PlayoffAdvanceWinnersPayload> {
  readonly commandType = CommandTypes.PLAYOFF_ADVANCE_WINNERS;

  async handle(_command: Command<PlayoffAdvanceWinnersPayload>): Promise<unknown> {
    throw new Error('Handler not implemented - use PlayoffService directly');
  }
}

export class PlayoffFinalizeHandler implements CommandHandler<PlayoffFinalizePayload> {
  readonly commandType = CommandTypes.PLAYOFF_FINALIZE;

  async handle(_command: Command<PlayoffFinalizePayload>): Promise<unknown> {
    throw new Error('Handler not implemented - use PlayoffService directly');
  }
}

/**
 * Get all playoff command handlers for registration.
 * NOTE: Currently returns empty array - handlers are placeholders.
 */
export function getPlayoffCommandHandlers(): CommandHandler[] {
  return [];
}
