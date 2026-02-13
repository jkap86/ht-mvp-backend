import { ActionHandler, ActionContext } from './index';
import { SlowAuctionService } from '../auction/slow-auction.service';
import { FastAuctionService } from '../auction/fast-auction.service';
import { RosterRepository } from '../../leagues/leagues.repository';
import { EventTypes, tryGetEventBus } from '../../../shared/events';
import { ForbiddenException, ValidationException, AppException } from '../../../utils/exceptions';
import { auctionLotToResponse } from '../auction/auction.models';

/**
 * Handles auction actions: nominate, set_max_bid
 * Routes to appropriate service based on auction mode (slow/fast)
 * Requires league membership and handles socket emissions
 */
export class AuctionActionHandler implements ActionHandler {
  readonly actions = ['nominate', 'set_max_bid'] as const;

  constructor(
    private readonly slowAuctionService: SlowAuctionService,
    private readonly fastAuctionService: FastAuctionService,
    private readonly rosterRepo: RosterRepository
  ) {}

  async handle(ctx: ActionContext, action: string, params: Record<string, any>): Promise<any> {
    // Get user's roster for this league
    const roster = await this.rosterRepo.findByLeagueAndUser(ctx.leagueId, ctx.userId);
    if (!roster) {
      throw new ForbiddenException('You are not a member of this league');
    }

    // Determine auction mode by checking draft settings
    const draft = await this.slowAuctionService.getDraft(ctx.draftId);
    const settings = this.slowAuctionService.getSettings(draft);
    const auctionMode = settings.auctionMode || 'slow';

    try {
      switch (action) {
        case 'nominate':
          if (auctionMode === 'fast') {
            return await this.handleFastNominate(
              ctx.draftId,
              ctx.userId,
              params.playerId,
              ctx.idempotencyKey ?? params.idempotencyKey
            );
          }
          return await this.handleNominate(
            ctx.draftId,
            roster.id,
            params.playerId,
            ctx.idempotencyKey ?? params.idempotencyKey
          );

        case 'set_max_bid':
          if (auctionMode === 'fast') {
            return await this.handleFastSetMaxBid(
              ctx.draftId,
              ctx.userId,
              params.lotId,
              params.maxBid,
              ctx.idempotencyKey ?? params.idempotencyKey
            );
          }
          return await this.handleSetMaxBid(
            ctx.draftId,
            roster.id,
            params.lotId,
            params.maxBid,
            ctx.idempotencyKey ?? params.idempotencyKey
          );

        default:
          throw new ValidationException(`AuctionActionHandler: Unknown action ${action}`);
      }
    } catch (error) {
      // Publish error event for real-time feedback
      if (error instanceof AppException) {
        const eventBus = tryGetEventBus();
        eventBus?.publish({
          type: EventTypes.AUCTION_ERROR,
          userId: ctx.userId,
          payload: {
            action,
            message: error.message,
          },
        });
      }
      throw error; // Re-throw for HTTP response
    }
  }

  private async handleNominate(
    draftId: number,
    rosterId: number,
    playerId: number,
    idempotencyKey?: string
  ): Promise<any> {
    const result = await this.slowAuctionService.nominate(
      draftId,
      rosterId,
      playerId,
      idempotencyKey
    );

    // Event publishing handled by SlowAuctionService (post-commit)

    return {
      ok: true,
      action: 'nominate',
      data: { lot: auctionLotToResponse(result.lot) },
      message: result.message,
    };
  }

  private async handleFastNominate(
    draftId: number,
    userId: string,
    playerId: number,
    idempotencyKey?: string
  ): Promise<any> {
    const result = await this.fastAuctionService.nominate(
      draftId,
      userId,
      playerId,
      idempotencyKey
    );

    // Socket events are handled by FastAuctionService

    return {
      ok: true,
      action: 'nominate',
      data: { lot: auctionLotToResponse(result.lot) },
      message: result.message,
    };
  }

  private async handleSetMaxBid(
    draftId: number,
    rosterId: number,
    lotId: number,
    maxBid: number,
    idempotencyKey?: string
  ): Promise<any> {
    const result = await this.slowAuctionService.setMaxBid(
      draftId,
      lotId,
      rosterId,
      maxBid,
      idempotencyKey
    );

    // Event publishing handled by SlowAuctionService (post-commit)

    return {
      ok: true,
      action: 'set_max_bid',
      data: {
        proxyBid: result.proxyBid,
        lot: auctionLotToResponse(result.lot),
        outbidNotifications: result.outbidNotifications,
      },
      message: result.message,
    };
  }

  private async handleFastSetMaxBid(
    draftId: number,
    userId: string,
    lotId: number,
    maxBid: number,
    idempotencyKey?: string
  ): Promise<any> {
    const result = await this.fastAuctionService.setMaxBid(
      draftId,
      userId,
      lotId,
      maxBid,
      idempotencyKey
    );

    // Socket events are handled by FastAuctionService

    return {
      ok: true,
      action: 'set_max_bid',
      data: {
        proxyBid: result.proxyBid,
        lot: auctionLotToResponse(result.lot),
        outbidNotifications: result.outbidNotifications,
      },
      message: result.message,
    };
  }
}
