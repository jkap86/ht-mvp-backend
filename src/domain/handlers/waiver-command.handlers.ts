/**
 * Waiver Command Handlers
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
  WaiverSubmitClaimPayload,
  WaiverCancelClaimPayload,
  WaiverReorderClaimsPayload,
  WaiverProcessLeaguePayload,
} from '../commands';

// Placeholder implementations - not currently registered

export class WaiverSubmitClaimHandler implements CommandHandler<WaiverSubmitClaimPayload> {
  readonly commandType = CommandTypes.WAIVER_SUBMIT_CLAIM;

  async handle(_command: Command<WaiverSubmitClaimPayload>): Promise<unknown> {
    throw new Error('Handler not implemented - use WaiversService directly');
  }
}

export class WaiverCancelClaimHandler implements CommandHandler<WaiverCancelClaimPayload> {
  readonly commandType = CommandTypes.WAIVER_CANCEL_CLAIM;

  async handle(_command: Command<WaiverCancelClaimPayload>): Promise<unknown> {
    throw new Error('Handler not implemented - use WaiversService directly');
  }
}

export class WaiverReorderClaimsHandler implements CommandHandler<WaiverReorderClaimsPayload> {
  readonly commandType = CommandTypes.WAIVER_REORDER_CLAIMS;

  async handle(_command: Command<WaiverReorderClaimsPayload>): Promise<unknown> {
    throw new Error('Handler not implemented - use WaiversService directly');
  }
}

export class WaiverProcessLeagueHandler implements CommandHandler<WaiverProcessLeaguePayload> {
  readonly commandType = CommandTypes.WAIVER_PROCESS_LEAGUE;

  async handle(_command: Command<WaiverProcessLeaguePayload>): Promise<unknown> {
    throw new Error('Handler not implemented - use ProcessWaiversUseCase directly');
  }
}

/**
 * Get all waiver command handlers for registration.
 * NOTE: Currently returns empty array - handlers are placeholders.
 */
export function getWaiverCommandHandlers(): CommandHandler[] {
  return [];
}
