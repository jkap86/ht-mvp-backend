import { ActionHandler, ActionContext } from './index';
import { SlowAuctionService } from '../auction/slow-auction.service';
import { RosterRepository } from '../../leagues/leagues.repository';
import { getSocketService } from '../../../socket';
import { ForbiddenException, ValidationException } from '../../../utils/exceptions';

/**
 * Handles auction actions: nominate, set_max_bid
 * Requires league membership and handles socket emissions
 */
export class AuctionActionHandler implements ActionHandler {
  readonly actions = ['nominate', 'set_max_bid'] as const;

  constructor(
    private readonly auctionService: SlowAuctionService,
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

    switch (action) {
      case 'nominate':
        return this.handleNominate(ctx.draftId, roster.id, params.playerId);

      case 'set_max_bid':
        return this.handleSetMaxBid(ctx.draftId, roster.id, params.lotId, params.maxBid);

      default:
        throw new ValidationException(`AuctionActionHandler: Unknown action ${action}`);
    }
  }

  private async handleNominate(
    draftId: number,
    rosterId: number,
    playerId: number
  ): Promise<any> {
    const result = await this.auctionService.nominate(draftId, rosterId, playerId);

    // Emit socket event
    try {
      const socket = getSocketService();
      socket.emitAuctionLotCreated(draftId, result.lot);
    } catch (socketError) {
      console.warn(`Failed to emit lot created event: ${socketError}`);
    }

    return result;
  }

  private async handleSetMaxBid(
    draftId: number,
    rosterId: number,
    lotId: number,
    maxBid: number
  ): Promise<any> {
    const result = await this.auctionService.setMaxBid(draftId, lotId, rosterId, maxBid);

    // Emit socket events
    try {
      const socket = getSocketService();
      socket.emitAuctionLotUpdated(draftId, result.lot);

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

    return result;
  }
}
