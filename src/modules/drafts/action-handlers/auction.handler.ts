import { ActionHandler, ActionContext } from './index';
import { SlowAuctionService } from '../auction/slow-auction.service';
import { FastAuctionService } from '../auction/fast-auction.service';
import { RosterRepository } from '../../leagues/leagues.repository';
import { getSocketService } from '../../../socket';
import { ForbiddenException, ValidationException, AppException } from '../../../utils/exceptions';

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

  async handle(
    ctx: ActionContext,
    action: string,
    params: Record<string, any>
  ): Promise<any> {
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
            return await this.handleFastNominate(ctx.draftId, ctx.userId, params.playerId);
          }
          return await this.handleNominate(ctx.draftId, roster.id, params.playerId);

        case 'set_max_bid':
          if (auctionMode === 'fast') {
            return await this.handleFastSetMaxBid(ctx.draftId, ctx.userId, params.lotId, params.maxBid);
          }
          return await this.handleSetMaxBid(ctx.draftId, roster.id, params.lotId, params.maxBid);

        default:
          throw new ValidationException(`AuctionActionHandler: Unknown action ${action}`);
      }
    } catch (error) {
      // Emit error to user via socket for real-time feedback
      if (error instanceof AppException) {
        try {
          const socket = getSocketService();
          socket.emitAuctionError(ctx.userId, {
            action,
            message: error.message,
          });
        } catch (socketError) {
          // Ignore socket errors - HTTP response will still contain the error
        }
      }
      throw error; // Re-throw for HTTP response
    }
  }

  private async handleNominate(
    draftId: number,
    rosterId: number,
    playerId: number
  ): Promise<any> {
    const result = await this.slowAuctionService.nominate(draftId, rosterId, playerId);

    // Emit socket event - wrap in { lot } for consistency with fast auction
    try {
      const socket = getSocketService();
      socket.emitAuctionLotCreated(draftId, { lot: result.lot });
    } catch (socketError) {
      console.warn(`Failed to emit lot created event: ${socketError}`);
    }

    return { ok: true, action: 'nominate', data: { lot: result.lot }, message: result.message };
  }

  private async handleFastNominate(
    draftId: number,
    userId: string,
    playerId: number
  ): Promise<any> {
    const result = await this.fastAuctionService.nominate(draftId, userId, playerId);

    // Socket events are handled by FastAuctionService

    return { ok: true, action: 'nominate', data: { lot: result.lot }, message: result.message };
  }

  private async handleSetMaxBid(
    draftId: number,
    rosterId: number,
    lotId: number,
    maxBid: number
  ): Promise<any> {
    const result = await this.slowAuctionService.setMaxBid(draftId, lotId, rosterId, maxBid);

    // Emit socket events - wrap in { lot } for consistency with fast auction
    try {
      const socket = getSocketService();
      socket.emitAuctionLotUpdated(draftId, { lot: result.lot });

      // Notify outbid users
      for (const notif of result.outbidNotifications) {
        const outbidRoster = await this.rosterRepo.findById(notif.rosterId);
        if (outbidRoster?.userId) {
          socket.emitAuctionOutbid(outbidRoster.userId, notif);
        }
      }
    } catch (socketError) {
      console.warn(`Failed to emit auction events: ${socketError}`);
    }

    return {
      ok: true,
      action: 'set_max_bid',
      data: {
        proxyBid: result.proxyBid,
        lot: result.lot,
        outbidNotifications: result.outbidNotifications
      },
      message: result.message
    };
  }

  private async handleFastSetMaxBid(
    draftId: number,
    userId: string,
    lotId: number,
    maxBid: number
  ): Promise<any> {
    const result = await this.fastAuctionService.setMaxBid(draftId, userId, lotId, maxBid);

    // Socket events are handled by FastAuctionService

    return {
      ok: true,
      action: 'set_max_bid',
      data: {
        proxyBid: result.proxyBid,
        lot: result.lot,
        outbidNotifications: result.outbidNotifications
      },
      message: result.message
    };
  }
}
