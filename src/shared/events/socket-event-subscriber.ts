import { DomainEvent, DomainEventSubscriber, EventTypes } from './domain-event-bus';
import { tryGetSocketService } from '../../socket/socket.service';
import { logger } from '../../config/env.config';

/**
 * SocketEventSubscriber translates domain events into Socket.IO emissions.
 *
 * This subscriber bridges the domain layer (which publishes events without
 * knowing about transport) to the Socket.IO layer (which handles real-time
 * communication with clients).
 *
 * Benefits:
 * - Domain services don't depend on Socket.IO
 * - Events are only emitted after domain logic completes (when used with transaction)
 * - Easy to add other subscribers (webhooks, logging, analytics)
 * - Testable: domain logic can be tested without socket mocking
 */
export class SocketEventSubscriber implements DomainEventSubscriber {
  handle(event: DomainEvent): void {
    const socketService = tryGetSocketService();
    if (!socketService) {
      // Socket service not initialized (e.g., during tests)
      return;
    }

    try {
      this.routeEvent(event, socketService);
    } catch (error) {
      logger.error(`Failed to emit socket event ${event.type}: ${error}`);
    }
  }

  private routeEvent(event: DomainEvent, socketService: ReturnType<typeof tryGetSocketService>): void {
    if (!socketService) return;

    switch (event.type) {
      // Draft events
      case EventTypes.DRAFT_PICK:
        socketService.emitDraftPick(event.payload.draftId as number, event.payload);
        break;
      case EventTypes.DRAFT_STARTED:
        socketService.emitDraftStarted(event.payload.draftId as number, event.payload);
        break;
      case EventTypes.DRAFT_COMPLETED:
        socketService.emitDraftCompleted(event.payload.draftId as number, event.payload);
        break;
      case EventTypes.DRAFT_PAUSED:
        socketService.emitDraftPaused(event.payload.draftId as number, event.payload);
        break;
      case EventTypes.DRAFT_RESUMED:
        socketService.emitDraftResumed(event.payload.draftId as number, event.payload);
        break;

      // Auction events
      case EventTypes.AUCTION_BID:
        socketService.emitAuctionLotUpdated(event.payload.draftId as number, event.payload);
        break;
      case EventTypes.AUCTION_LOT_SOLD:
        socketService.emitAuctionLotWon(
          event.payload.draftId as number,
          event.payload as { lotId: number; playerId: number; winnerRosterId: number; price: number }
        );
        break;
      case EventTypes.AUCTION_LOT_STARTED:
        socketService.emitAuctionLotCreated(event.payload.draftId as number, event.payload);
        break;

      // Trade events
      case EventTypes.TRADE_PROPOSED:
        if (event.leagueId) {
          socketService.emitTradeProposed(event.leagueId, event.payload);
        }
        break;
      case EventTypes.TRADE_ACCEPTED:
        if (event.leagueId) {
          socketService.emitTradeAccepted(event.leagueId, event.payload);
        }
        break;
      case EventTypes.TRADE_REJECTED:
        if (event.leagueId) {
          socketService.emitTradeRejected(event.leagueId, event.payload);
        }
        break;
      case EventTypes.TRADE_CANCELLED:
        if (event.leagueId) {
          socketService.emitTradeCancelled(event.leagueId, event.payload);
        }
        break;
      case EventTypes.TRADE_VETOED:
        if (event.leagueId) {
          socketService.emitTradeVetoed(event.leagueId, event.payload);
        }
        break;

      // Waiver events
      case EventTypes.WAIVER_CLAIMED:
        if (event.leagueId) {
          socketService.emitWaiverClaimSubmitted(event.leagueId, event.payload);
        }
        break;
      case EventTypes.WAIVER_PROCESSED:
        if (event.leagueId) {
          socketService.emitWaiversProcessed(
            event.leagueId,
            event.payload as { processed: number; successful: number }
          );
        }
        break;

      // Scoring events
      case EventTypes.SCORES_UPDATED:
        if (event.leagueId) {
          socketService.emitScoresUpdated(
            event.leagueId,
            event.payload as { week: number; matchups: unknown[] }
          );
        }
        break;
      case EventTypes.MATCHUP_FINALIZED:
        if (event.leagueId) {
          socketService.emitWeekFinalized(
            event.leagueId,
            event.payload as { week: number }
          );
        }
        break;

      // Chat events
      case EventTypes.CHAT_MESSAGE:
        if (event.leagueId) {
          socketService.emitChatMessage(event.leagueId, event.payload);
        }
        break;
      case EventTypes.DM_MESSAGE:
        if (event.userId) {
          socketService.emitDmMessage(
            event.userId,
            event.payload.conversationId as number,
            event.payload.message
          );
        }
        break;

      // Roster events
      case EventTypes.ROSTER_UPDATED:
        // No direct socket method for this - roster updates are typically
        // reflected through other events (waiver processed, trade completed, etc.)
        // Skip for now as there's no generic roster:updated event handler
        break;

      // League events
      case EventTypes.MEMBER_JOINED:
        if (event.leagueId) {
          socketService.emitMemberJoined(
            event.leagueId,
            event.payload as { rosterId: number; teamName: string; userId: string }
          );
        }
        break;
      case EventTypes.MEMBER_LEFT:
        if (event.leagueId) {
          socketService.emitMemberKicked(
            event.leagueId,
            event.payload as { rosterId: number; teamName: string }
          );
        }
        break;

      default:
        // Unknown event type - log for debugging but don't fail
        logger.debug(`Unhandled domain event type: ${event.type}`);
    }
  }
}
