import { Pool } from 'pg';
import { DomainEvent, DomainEventSubscriber, EventTypes } from './domain-event-bus';
import { NotificationService, PushNotificationPayload } from '../../modules/notifications/notification.service';
import { logger } from '../../config/logger.config';

/**
 * NotificationEventSubscriber translates domain events into push notifications
 * via Firebase Cloud Messaging (through NotificationService).
 */
export class NotificationEventSubscriber implements DomainEventSubscriber {
  constructor(
    private readonly pool: Pool,
    private readonly notificationService: NotificationService
  ) {}

  async handle(event: DomainEvent): Promise<void> {
    try {
      switch (event.type) {
        case EventTypes.TRADE_PROPOSED:
          await this.handleTradeProposed(event);
          break;
        case EventTypes.DRAFT_NEXT_PICK:
          await this.handleDraftNextPick(event);
          break;
        case EventTypes.WAIVER_CLAIM_SUCCESSFUL:
          await this.handleWaiverResult(event, true);
          break;
        case EventTypes.WAIVER_CLAIM_FAILED:
          await this.handleWaiverResult(event, false);
          break;
        case EventTypes.MATCHUP_FINALIZED:
          await this.handleWeekFinalized(event);
          break;
        default:
          // Not all events need push notifications
          break;
      }
    } catch (error) {
      logger.error(`NotificationEventSubscriber error for ${event.type}: ${error}`);
    }
  }

  private async handleTradeProposed(event: DomainEvent): Promise<void> {
    const targetRosterId = event.payload.targetRosterId as number | undefined;
    if (!targetRosterId) return;

    const userId = await this.getUserIdForRoster(targetRosterId);
    if (!userId) return;

    const notification: PushNotificationPayload = {
      title: 'New Trade Proposal',
      body: 'You have received a trade offer',
      data: {
        type: 'trade_proposed',
        tradeId: String(event.payload.tradeId ?? ''),
        leagueId: String(event.leagueId ?? ''),
      },
    };

    await this.notificationService.sendPushNotification(userId, notification);
  }

  private async handleDraftNextPick(event: DomainEvent): Promise<void> {
    const currentRosterId = event.payload.currentRosterId as number | undefined;
    if (!currentRosterId) return;

    const userId = await this.getUserIdForRoster(currentRosterId);
    if (!userId) return;

    const notification: PushNotificationPayload = {
      title: 'Your Turn to Pick',
      body: 'You are on the clock!',
      data: {
        type: 'draft_next_pick',
        draftId: String(event.payload.draftId ?? ''),
        leagueId: String(event.leagueId ?? ''),
      },
    };

    await this.notificationService.sendPushNotification(userId, notification);
  }

  private async handleWaiverResult(event: DomainEvent, success: boolean): Promise<void> {
    const userId = event.userId;
    if (!userId) return;

    const notification: PushNotificationPayload = {
      title: success ? 'Waiver Claim Successful' : 'Waiver Claim Failed',
      body: success
        ? 'Your waiver claim was successful'
        : 'Your waiver claim was not successful',
      data: {
        type: success ? 'waiver_claim_successful' : 'waiver_claim_failed',
        claimId: String(event.payload.claimId ?? ''),
        leagueId: String(event.leagueId ?? ''),
      },
    };

    await this.notificationService.sendPushNotification(userId, notification);
  }

  private async handleWeekFinalized(event: DomainEvent): Promise<void> {
    const leagueId = event.leagueId;
    if (!leagueId) return;

    const userIds = await this.getLeagueMemberUserIds(leagueId);
    if (userIds.length === 0) return;

    const notification: PushNotificationPayload = {
      title: 'Week Finalized',
      body: `Week ${event.payload.week ?? ''} matchups have been finalized`,
      data: {
        type: 'week_finalized',
        leagueId: String(leagueId),
        week: String(event.payload.week ?? ''),
      },
    };

    await this.notificationService.sendBatchNotifications(userIds, notification);
  }

  private async getUserIdForRoster(rosterId: number): Promise<string | null> {
    const result = await this.pool.query(
      'SELECT user_id FROM rosters WHERE id = $1',
      [rosterId]
    );
    return result.rows[0]?.user_id ?? null;
  }

  private async getLeagueMemberUserIds(leagueId: number): Promise<string[]> {
    const result = await this.pool.query(
      'SELECT DISTINCT user_id FROM rosters WHERE league_id = $1 AND user_id IS NOT NULL',
      [leagueId]
    );
    return result.rows.map((r) => r.user_id);
  }
}
