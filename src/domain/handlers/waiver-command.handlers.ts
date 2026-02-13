/**
 * Waiver Command Handlers
 *
 * Wires waiver commands to WaiversService.
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
import { container, KEYS } from '../../container';
import type { WaiversService } from '../../modules/waivers/waivers.service';

export class WaiverSubmitClaimHandler implements CommandHandler<WaiverSubmitClaimPayload> {
  readonly commandType = CommandTypes.WAIVER_SUBMIT_CLAIM;

  async handle(command: Command<WaiverSubmitClaimPayload>): Promise<unknown> {
    const { leagueId, playerId, dropPlayerId, bidAmount } = command.payload;
    const userId = command.actor.userId;
    if (!userId) throw new Error('Waiver submit claim requires a user actor');

    const waiversService = container.resolve<WaiversService>(KEYS.WAIVERS_SERVICE);
    return waiversService.submitClaim(
      leagueId,
      userId,
      { playerId, dropPlayerId, bidAmount },
      command.metadata?.idempotencyKey
    );
  }
}

export class WaiverCancelClaimHandler implements CommandHandler<WaiverCancelClaimPayload> {
  readonly commandType = CommandTypes.WAIVER_CANCEL_CLAIM;

  async handle(command: Command<WaiverCancelClaimPayload>): Promise<unknown> {
    const { claimId } = command.payload;
    const userId = command.actor.userId;
    if (!userId) throw new Error('Waiver cancel claim requires a user actor');

    const waiversService = container.resolve<WaiversService>(KEYS.WAIVERS_SERVICE);
    return waiversService.cancelClaim(claimId, userId);
  }
}

export class WaiverReorderClaimsHandler implements CommandHandler<WaiverReorderClaimsPayload> {
  readonly commandType = CommandTypes.WAIVER_REORDER_CLAIMS;

  async handle(command: Command<WaiverReorderClaimsPayload>): Promise<unknown> {
    const { leagueId, claimIds } = command.payload;
    const userId = command.actor.userId;
    if (!userId) throw new Error('Waiver reorder claims requires a user actor');

    const waiversService = container.resolve<WaiversService>(KEYS.WAIVERS_SERVICE);
    return waiversService.reorderClaims(leagueId, userId, claimIds);
  }
}

export class WaiverProcessLeagueHandler implements CommandHandler<WaiverProcessLeaguePayload> {
  readonly commandType = CommandTypes.WAIVER_PROCESS_LEAGUE;

  async handle(command: Command<WaiverProcessLeaguePayload>): Promise<unknown> {
    const { leagueId } = command.payload;

    const waiversService = container.resolve<WaiversService>(KEYS.WAIVERS_SERVICE);
    return waiversService.processLeagueClaims(leagueId);
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
