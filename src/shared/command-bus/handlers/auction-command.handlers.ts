/**
 * Auction Command Handlers
 *
 * Wires auction commands to the FastAuctionService and SlowAuctionService.
 */

import { CommandHandler } from '../command-bus';
import {
  Command,
  CommandTypes,
  AuctionNominatePayload,
  AuctionSetMaxBidPayload,
  AuctionPlaceBidPayload,
} from '../../../domain/commands';
import { container, KEYS } from '../../../container';
import type { FastAuctionService } from '../../../modules/drafts/auction/fast-auction.service';
import type { SlowAuctionService } from '../../../modules/drafts/auction/slow-auction.service';

export class AuctionNominateHandler implements CommandHandler<AuctionNominatePayload> {
  readonly commandType = CommandTypes.AUCTION_NOMINATE;

  async handle(command: Command<AuctionNominatePayload>): Promise<unknown> {
    const { draftId, playerId } = command.payload;
    const userId = command.actor.userId;
    if (!userId) throw new Error('Auction nominate requires a user actor');

    const fastAuctionService = container.resolve<FastAuctionService>(KEYS.FAST_AUCTION_SERVICE);
    return fastAuctionService.nominate(draftId, userId, playerId, command.metadata?.idempotencyKey);
  }
}

export class AuctionSetMaxBidHandler implements CommandHandler<AuctionSetMaxBidPayload> {
  readonly commandType = CommandTypes.AUCTION_SET_MAX_BID;

  async handle(command: Command<AuctionSetMaxBidPayload>): Promise<unknown> {
    const { draftId, lotId, maxBid } = command.payload;
    const userId = command.actor.userId;
    if (!userId) throw new Error('Auction set max bid requires a user actor');

    const fastAuctionService = container.resolve<FastAuctionService>(KEYS.FAST_AUCTION_SERVICE);
    return fastAuctionService.setMaxBid(draftId, userId, lotId, maxBid, command.metadata?.idempotencyKey);
  }
}

export class AuctionPlaceBidHandler implements CommandHandler<AuctionPlaceBidPayload> {
  readonly commandType = CommandTypes.AUCTION_PLACE_BID;

  async handle(command: Command<AuctionPlaceBidPayload>): Promise<unknown> {
    const { leagueId, draftId, lotId, bidAmount } = command.payload;
    const userId = command.actor.userId;
    if (!userId) throw new Error('Auction place bid requires a user actor');

    // SlowAuctionService.setMaxBid takes rosterId (number), not userId (string).
    // Resolve the roster first, then delegate to the service.
    const { RosterRepository } = await import('../../../modules/rosters/roster.repository');
    const rosterRepo = container.resolve<InstanceType<typeof RosterRepository>>(KEYS.ROSTER_REPO);
    const roster = await rosterRepo.findByLeagueAndUser(leagueId, userId);
    if (!roster) throw new Error('User does not have a roster in this league');

    const slowAuctionService = container.resolve<SlowAuctionService>(KEYS.SLOW_AUCTION_SERVICE);
    return slowAuctionService.setMaxBid(draftId, lotId, roster.id, bidAmount, command.metadata?.idempotencyKey);
  }
}

/**
 * Get all auction command handlers for registration.
 */
export function getAuctionCommandHandlers(): CommandHandler[] {
  return [
    new AuctionNominateHandler(),
    new AuctionSetMaxBidHandler(),
    new AuctionPlaceBidHandler(),
  ];
}
