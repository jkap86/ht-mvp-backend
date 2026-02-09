/**
 * Waiver Command Handlers
 *
 * Handlers for waiver-related commands. These handlers wrap the existing
 * waiver services and use-case functions.
 */

import { CommandHandler, Command } from '../command-bus';
import {
  CommandTypes,
  WaiverSubmitClaimPayload,
  WaiverCancelClaimPayload,
  WaiverReorderClaimsPayload,
  WaiverProcessLeaguePayload,
} from '../commands';
import { container, KEYS } from '../../container';
import type { WaiversService } from '../../modules/waivers/waivers.service';

/**
 * Handle WAIVER_SUBMIT_CLAIM command - submit a new waiver claim
 */
export class WaiverSubmitClaimHandler implements CommandHandler<WaiverSubmitClaimPayload> {
  readonly commandType = CommandTypes.WAIVER_SUBMIT_CLAIM;

  async handle(command: Command<WaiverSubmitClaimPayload>): Promise<unknown> {
    const waiversService = container.resolve<WaiversService>(KEYS.WAIVERS_SERVICE);

    const userId = command.actor.userId;
    if (!userId) {
      throw new Error('User ID required to submit waiver claim');
    }

    return await waiversService.submitClaim(
      command.payload.leagueId,
      userId,
      command.payload.playerId,
      command.payload.dropPlayerId,
      command.payload.bidAmount
    );
  }
}

/**
 * Handle WAIVER_CANCEL_CLAIM command - cancel a pending claim
 */
export class WaiverCancelClaimHandler implements CommandHandler<WaiverCancelClaimPayload> {
  readonly commandType = CommandTypes.WAIVER_CANCEL_CLAIM;

  async handle(command: Command<WaiverCancelClaimPayload>): Promise<unknown> {
    const waiversService = container.resolve<WaiversService>(KEYS.WAIVERS_SERVICE);

    const userId = command.actor.userId;
    if (!userId) {
      throw new Error('User ID required to cancel waiver claim');
    }

    return await waiversService.cancelClaim(
      command.payload.leagueId,
      command.payload.claimId,
      userId
    );
  }
}

/**
 * Handle WAIVER_REORDER_CLAIMS command - reorder pending claims
 */
export class WaiverReorderClaimsHandler implements CommandHandler<WaiverReorderClaimsPayload> {
  readonly commandType = CommandTypes.WAIVER_REORDER_CLAIMS;

  async handle(command: Command<WaiverReorderClaimsPayload>): Promise<unknown> {
    const waiversService = container.resolve<WaiversService>(KEYS.WAIVERS_SERVICE);

    const userId = command.actor.userId;
    if (!userId) {
      throw new Error('User ID required to reorder claims');
    }

    return await waiversService.reorderClaims(
      command.payload.leagueId,
      userId,
      command.payload.claimIds
    );
  }
}

/**
 * Handle WAIVER_PROCESS_LEAGUE command - process waivers for a league (system command)
 */
export class WaiverProcessLeagueHandler implements CommandHandler<WaiverProcessLeaguePayload> {
  readonly commandType = CommandTypes.WAIVER_PROCESS_LEAGUE;

  async handle(command: Command<WaiverProcessLeaguePayload>): Promise<unknown> {
    const waiversService = container.resolve<WaiversService>(KEYS.WAIVERS_SERVICE);

    // This is typically a system-initiated command from the waiver processing job
    return await waiversService.processLeagueWaivers(command.payload.leagueId);
  }
}

/**
 * Get all waiver command handlers for registration.
 */
export function getWaiverCommandHandlers(): CommandHandler[] {
  return [
    new WaiverSubmitClaimHandler(),
    new WaiverCancelClaimHandler(),
    new WaiverReorderClaimsHandler(),
    new WaiverProcessLeagueHandler(),
  ];
}
