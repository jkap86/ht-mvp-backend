/**
 * Playoff Command Handlers
 *
 * Wires playoff commands to PlayoffService.
 */

import { CommandHandler } from '../command-bus';
import {
  Command,
  CommandTypes,
  PlayoffGenerateBracketPayload,
  PlayoffAdvanceWinnersPayload,
  PlayoffFinalizePayload,
} from '../../../domain/commands';
import { container, KEYS } from '../../../container';
import type { PlayoffService } from '../../../modules/playoffs/playoff.service';

export class PlayoffGenerateBracketHandler implements CommandHandler<PlayoffGenerateBracketPayload> {
  readonly commandType = CommandTypes.PLAYOFF_GENERATE_BRACKET;

  async handle(command: Command<PlayoffGenerateBracketPayload>): Promise<unknown> {
    const { leagueId, playoffTeams, startWeek, weeksByRound, enableThirdPlace, consolationType, consolationTeams } = command.payload;
    const userId = command.actor.userId;
    if (!userId) throw new Error('Playoff generate bracket requires a user actor');

    const playoffService = container.resolve<PlayoffService>(KEYS.PLAYOFF_SERVICE);
    return playoffService.generatePlayoffBracket(
      leagueId,
      userId,
      {
        playoffTeams,
        startWeek,
        weeksByRound,
        enableThirdPlaceGame: enableThirdPlace,
        consolationType,
        consolationTeams,
      },
      command.metadata?.idempotencyKey
    );
  }
}

export class PlayoffAdvanceWinnersHandler implements CommandHandler<PlayoffAdvanceWinnersPayload> {
  readonly commandType = CommandTypes.PLAYOFF_ADVANCE_WINNERS;

  async handle(command: Command<PlayoffAdvanceWinnersPayload>): Promise<unknown> {
    const { leagueId, week } = command.payload;
    const userId = command.actor.userId;
    if (!userId) throw new Error('Playoff advance winners requires a user actor');

    const playoffService = container.resolve<PlayoffService>(KEYS.PLAYOFF_SERVICE);
    return playoffService.advanceWinners(leagueId, week, userId, command.metadata?.idempotencyKey);
  }
}

export class PlayoffFinalizeHandler implements CommandHandler<PlayoffFinalizePayload> {
  readonly commandType = CommandTypes.PLAYOFF_FINALIZE;

  async handle(_command: Command<PlayoffFinalizePayload>): Promise<unknown> {
    // Finalize is handled by the advance flow when bracket is complete.
    // This handler is a no-op for now — bracket finalization happens automatically.
    throw new Error('Playoff finalize is handled automatically during advancement');
  }
}

/**
 * Get all playoff command handlers for registration.
 */
export function getPlayoffCommandHandlers(): CommandHandler[] {
  return [
    new PlayoffGenerateBracketHandler(),
    new PlayoffAdvanceWinnersHandler(),
    // PlayoffFinalizeHandler not registered — finalization is automatic
  ];
}
