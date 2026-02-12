import { DomainEvent, DomainEventSubscriber, EventTypes } from './domain-event-bus';
import { tryGetSocketService } from '../../socket/socket.service';
import { logger } from '../../config/logger.config';

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
      case EventTypes.AUCTION_LOT_PASSED:
        socketService.emitAuctionLotPassed(
          event.payload.draftId as number,
          event.payload as { lotId: number; playerId: number }
        );
        break;
      case EventTypes.AUCTION_OUTBID:
        if (event.userId) {
          socketService.emitAuctionOutbid(event.userId, event.payload);
        }
        break;
      case EventTypes.AUCTION_NOMINATOR_CHANGED:
        socketService.emitAuctionNominatorChanged(
          event.payload.draftId as number,
          event.payload as { nominatorRosterId: number; nominationNumber: number; nominationDeadline: string }
        );
        break;
      case EventTypes.AUCTION_ERROR:
        if (event.userId) {
          socketService.emitAuctionError(
            event.userId,
            event.payload as { action: string; message: string }
          );
        }
        break;

      // Derby events
      case EventTypes.DERBY_STATE:
        socketService.emitDerbyState(event.payload.draftId as number, event.payload);
        break;
      case EventTypes.DERBY_SLOT_PICKED:
        socketService.emitDerbySlotPicked(event.payload.draftId as number, event.payload);
        break;
      case EventTypes.DERBY_TURN_CHANGED:
        socketService.emitDerbyTurnChanged(event.payload.draftId as number, event.payload);
        break;
      case EventTypes.DERBY_PHASE_TRANSITION:
        socketService.emitDerbyPhaseTransition(
          event.payload.draftId as number,
          event.payload as { phase: string }
        );
        break;

      // Draft navigation events
      case EventTypes.DRAFT_NEXT_PICK:
        socketService.emitNextPick(event.payload.draftId as number, event.payload);
        break;
      case EventTypes.DRAFT_QUEUE_UPDATED:
        socketService.emitQueueUpdated(
          event.payload.draftId as number,
          event.payload as { playerId: number; action: string }
        );
        break;
      case EventTypes.DRAFT_AUTODRAFT_TOGGLED:
        socketService.emitAutodraftToggled(
          event.payload.draftId as number,
          event.payload as { rosterId: number; enabled: boolean; forced: boolean }
        );
        break;
      case EventTypes.DRAFT_SETTINGS_UPDATED:
        socketService.emitDraftSettingsUpdated(event.payload.draftId as number, event.payload);
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
      case EventTypes.TRADE_COUNTERED:
        if (event.leagueId) {
          socketService.emitTradeCountered(event.leagueId, event.payload);
        }
        break;
      case EventTypes.TRADE_COMPLETED:
        if (event.leagueId) {
          socketService.emitTradeCompleted(event.leagueId, event.payload);
        }
        break;
      case EventTypes.TRADE_EXPIRED:
        if (event.leagueId) {
          socketService.emitTradeExpired(event.leagueId, event.payload);
        }
        break;
      case EventTypes.TRADE_FAILED:
        if (event.leagueId) {
          socketService.emitTradeFailed(
            event.leagueId,
            event.payload as { tradeId: number; reason: string }
          );
        }
        break;
      case EventTypes.TRADE_INVALIDATED:
        if (event.leagueId) {
          socketService.emitTradeInvalidated(
            event.leagueId,
            event.payload as { tradeId: number; reason: string }
          );
        }
        break;
      case EventTypes.TRADE_VOTE_CAST:
        if (event.leagueId) {
          socketService.emitTradeVoteCast(event.leagueId, event.payload);
        }
        break;
      case EventTypes.PICK_TRADED:
        if (event.leagueId) {
          socketService.emitPickTraded(
            event.leagueId,
            event.payload as {
              pickAssetId: number;
              season: number;
              round: number;
              previousOwnerRosterId: number;
              newOwnerRosterId: number;
              tradeId: number;
            }
          );
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
      case EventTypes.WAIVER_CLAIM_SUCCESSFUL:
        if (event.userId) {
          socketService.emitWaiverClaimSuccessful(event.userId, event.payload);
        }
        break;
      case EventTypes.WAIVER_CLAIM_FAILED:
        if (event.userId) {
          socketService.emitWaiverClaimFailed(event.userId, event.payload as { claimId: number; reason: string });
        }
        break;
      case EventTypes.WAIVER_CLAIM_CANCELLED:
        if (event.leagueId) {
          socketService.emitWaiverClaimCancelled(event.leagueId, event.payload as { claimId: number; rosterId: number });
        }
        break;
      case EventTypes.WAIVER_CLAIM_UPDATED:
        if (event.leagueId) {
          socketService.emitWaiverClaimUpdated(event.leagueId, event.payload);
        }
        break;
      case EventTypes.WAIVER_PRIORITY_UPDATED:
        if (event.leagueId) {
          socketService.emitWaiverPriorityUpdated(event.leagueId, event.payload.priorities as unknown[]);
        }
        break;
      case EventTypes.WAIVER_BUDGET_UPDATED:
        if (event.leagueId) {
          socketService.emitWaiverBudgetUpdated(event.leagueId, event.payload.budgets as unknown[]);
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
      case EventTypes.DM_READ:
        if (event.userId) {
          socketService.emitDmRead(
            event.userId,
            event.payload.conversationId as number,
            event.payload.readByUserId as string
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
          const joinedUserId = (event.payload as { userId?: string }).userId;
          socketService.emitMemberJoined(
            event.leagueId,
            event.payload as { rosterDbId: number; rosterSlotId: number; teamName: string; userId: string }
          );
          if (joinedUserId) {
            socketService.invalidateMembershipCache(event.leagueId, joinedUserId).catch((err) =>
              logger.error('Failed to invalidate membership cache after join', { error: err })
            );
          }
        }
        break;
      case EventTypes.MEMBER_LEFT:
        if (event.leagueId) {
          const leftUserId = (event.payload as { userId?: string }).userId;
          socketService.emitMemberKicked(
            event.leagueId,
            event.payload as { rosterDbId: number; rosterSlotId: number; teamName: string }
          );
          if (leftUserId) {
            socketService.invalidateMembershipCache(event.leagueId, leftUserId).catch((err) =>
              logger.error('Failed to invalidate membership cache after leave', { error: err })
            );
            socketService.evictUserFromLeagueRooms(event.leagueId, leftUserId).catch((err) =>
              logger.error('Failed to evict user from rooms after leave', { error: err })
            );
          }
        }
        break;
      case EventTypes.MEMBER_KICKED:
        if (event.leagueId) {
          const kickedUserId = (event.payload as { userId?: string }).userId;
          // 1. Emit kick event first (user sees it while still in room)
          socketService.emitMemberKicked(
            event.leagueId,
            event.payload as { rosterDbId: number; rosterSlotId: number; teamName: string; userId?: string }
          );
          if (kickedUserId) {
            // 2. Invalidate cache (prevents re-joining)
            socketService.invalidateMembershipCache(event.leagueId, kickedUserId).catch((err) =>
              logger.error('Failed to invalidate membership cache after kick', { error: err })
            );
            // 3. Evict from rooms (stops receiving further events)
            socketService.evictUserFromLeagueRooms(event.leagueId, kickedUserId).catch((err) =>
              logger.error('Failed to evict kicked user from rooms', { error: err })
            );
          }
        }
        break;
      case EventTypes.MEMBER_BENCHED:
        if (event.leagueId) {
          socketService.emitMemberBenched(
            event.leagueId,
            event.payload as { rosterDbId: number; rosterSlotId: number; teamName: string }
          );
        }
        break;
      case EventTypes.LEAGUE_SETTINGS_UPDATED:
        if (event.leagueId) {
          socketService.emitLeagueSettingsUpdated(
            event.leagueId,
            event.payload as { leagueId: number; changedSettings: string[] }
          );
        }
        break;
      case EventTypes.LEAGUE_WEEK_ADVANCED:
        if (event.leagueId) {
          socketService.emitLeagueWeekAdvanced(
            event.leagueId,
            event.payload as { week: number; seasonType: string }
          );
        }
        break;

      // Invitation events
      case EventTypes.INVITATION_RECEIVED:
        if (event.userId) {
          socketService.emitToUser(
            event.userId,
            'invitation:received',
            event.payload
          );
        }
        break;
      case EventTypes.INVITATION_DECLINED:
        if (event.userId) {
          socketService.emitToUser(event.userId, 'invitation:declined', event.payload);
        }
        break;
      case EventTypes.INVITATION_CANCELLED:
        if (event.userId) {
          socketService.emitToUser(event.userId, 'invitation:cancelled', event.payload);
        }
        break;

      // Playoff events
      case EventTypes.PLAYOFF_BRACKET_GENERATED:
        if (event.leagueId) {
          socketService.emitPlayoffBracketGenerated(
            event.leagueId,
            event.payload as { bracketId: number }
          );
        }
        break;
      case EventTypes.PLAYOFF_WINNERS_ADVANCED:
        if (event.leagueId) {
          socketService.emitPlayoffWinnersAdvanced(
            event.leagueId,
            event.payload as { week: number }
          );
        }
        break;
      case EventTypes.PLAYOFF_CHAMPION_CROWNED:
        if (event.leagueId) {
          socketService.emitPlayoffChampionCrowned(
            event.leagueId,
            event.payload as { bracketId: number; championRosterId: number }
          );
        }
        break;

      default:
        // Unknown event type - log for debugging but don't fail
        logger.debug(`Unhandled domain event type: ${event.type}`);
    }
  }
}
