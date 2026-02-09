/**
 * Playoff Command Handlers
 *
 * Handlers for playoff-related commands. These handlers wrap the existing
 * playoff service methods.
 */

import { CommandHandler, Command } from '../command-bus';
import {
  CommandTypes,
  PlayoffGenerateBracketPayload,
  PlayoffAdvanceWinnersPayload,
  PlayoffFinalizePayload,
} from '../commands';
import { container, KEYS } from '../../container';
import type { PlayoffService } from '../../modules/playoffs/playoff.service';

/**
 * Handle PLAYOFF_GENERATE_BRACKET command - generate playoff bracket
 */
export class PlayoffGenerateBracketHandler implements CommandHandler<PlayoffGenerateBracketPayload> {
  readonly commandType = CommandTypes.PLAYOFF_GENERATE_BRACKET;

  async handle(command: Command<PlayoffGenerateBracketPayload>): Promise<unknown> {
    const playoffService = container.resolve<PlayoffService>(KEYS.PLAYOFF_SERVICE);

    const userId = command.actor.userId;
    if (!userId) {
      throw new Error('User ID required to generate playoff bracket');
    }

    return await playoffService.generateBracket(
      command.payload.leagueId,
      userId,
      {
        season: command.payload.season,
        playoffTeams: command.payload.playoffTeams,
        startWeek: command.payload.startWeek,
        weeksByRound: command.payload.weeksByRound,
        enableThirdPlace: command.payload.enableThirdPlace,
        consolationType: command.payload.consolationType,
        consolationTeams: command.payload.consolationTeams,
      }
    );
  }
}

/**
 * Handle PLAYOFF_ADVANCE_WINNERS command - advance winners to next round
 */
export class PlayoffAdvanceWinnersHandler implements CommandHandler<PlayoffAdvanceWinnersPayload> {
  readonly commandType = CommandTypes.PLAYOFF_ADVANCE_WINNERS;

  async handle(command: Command<PlayoffAdvanceWinnersPayload>): Promise<unknown> {
    const playoffService = container.resolve<PlayoffService>(KEYS.PLAYOFF_SERVICE);

    const userId = command.actor.userId;
    if (!userId) {
      throw new Error('User ID required to advance playoff winners');
    }

    return await playoffService.advanceWinners(
      command.payload.leagueId,
      command.payload.week,
      userId
    );
  }
}

/**
 * Handle PLAYOFF_FINALIZE command - finalize playoff bracket
 */
export class PlayoffFinalizeHandler implements CommandHandler<PlayoffFinalizePayload> {
  readonly commandType = CommandTypes.PLAYOFF_FINALIZE;

  async handle(command: Command<PlayoffFinalizePayload>): Promise<unknown> {
    const playoffService = container.resolve<PlayoffService>(KEYS.PLAYOFF_SERVICE);

    const userId = command.actor.userId;
    if (!userId) {
      throw new Error('User ID required to finalize playoffs');
    }

    // Note: If finalize method doesn't exist, this would be added as part of playoff engine extraction
    // For now, we can call the existing method that handles this
    return await playoffService.finalizeBracket(
      command.payload.leagueId,
      command.payload.season,
      userId
    );
  }
}

/**
 * Get all playoff command handlers for registration.
 */
export function getPlayoffCommandHandlers(): CommandHandler[] {
  return [
    new PlayoffGenerateBracketHandler(),
    new PlayoffAdvanceWinnersHandler(),
    new PlayoffFinalizeHandler(),
  ];
}
