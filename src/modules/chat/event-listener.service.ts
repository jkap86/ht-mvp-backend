import { SystemMessageService } from './system-message.service';
import { TradesRepository } from '../trades/trades.repository';
import { RosterRepository, LeagueRepository } from '../leagues/leagues.repository';
import { DmService } from '../dm/dm.service';
import { MessageType } from './chat.model';
import { LeagueChatMode, TradeWithDetails } from '../trades/trades.model';
import {
  formatTradeForNotifications,
  getEffectiveLeagueChatMode,
} from '../trades/trade-notification.utils';
import { logger } from '../../config/logger.config';

/**
 * Notification policy for system messages
 * - 'always': Always send to league chat
 * - 'never': Never send to league chat
 * - 'user_choice': Respect user preference per-trade
 */
export type NotificationPolicy = 'always' | 'never' | 'user_choice';

/**
 * Options for trade notification handling
 */
export interface TradeNotificationOptions {
  notifyLeagueChat?: boolean; // Legacy boolean (for backward compat)
  leagueChatMode?: LeagueChatMode; // New 3-state mode
  notifyDm?: boolean; // Send DM to recipient
}

/**
 * Service for listening to league events and creating system messages
 */
export class EventListenerService {
  constructor(
    private readonly systemMessageService: SystemMessageService,
    private readonly tradesRepo: TradesRepository,
    private readonly rosterRepo: RosterRepository,
    private readonly leagueRepo: LeagueRepository,
    private readonly dmService?: DmService // Optional for backward compat
  ) {}

  /**
   * Handle trade proposed event
   */
  async handleTradeProposed(
    leagueId: number,
    tradeId: number,
    options?: TradeNotificationOptions
  ): Promise<void> {
    const trade = await this.tradesRepo.findByIdWithDetails(tradeId);
    if (!trade) return;

    const league = await this.leagueRepo.findById(leagueId);
    if (!league) return;

    // Get commissioner settings for trade notifications
    const commMax =
      (league.leagueSettings?.tradeProposalLeagueChatMax as LeagueChatMode) || 'details';
    const commDefault =
      (league.leagueSettings?.tradeProposalLeagueChatDefault as LeagueChatMode) || 'summary';

    // Determine effective league chat mode
    const effectiveMode = getEffectiveLeagueChatMode(
      options?.leagueChatMode,
      options?.notifyLeagueChat,
      commMax,
      commDefault
    );

    // Handle league chat notification
    if (effectiveMode !== 'none') {
      const { details } = formatTradeForNotifications(trade);

      await this.systemMessageService.createAndBroadcast(leagueId, 'trade_proposed', {
        tradeId,
        fromTeam: trade.proposerTeamName,
        toTeam: trade.recipientTeamName,
        fromRosterId: trade.proposerRosterId,
        toRosterId: trade.recipientRosterId,
        details: effectiveMode === 'details' ? details : undefined,
      });
    }

    // Handle DM notification (NOT capped by commissioner)
    if (options?.notifyDm !== false) {
      await this.sendTradeDm(trade);
    }
  }

  /**
   * Handle trade accepted event (may go to review or complete immediately)
   */
  async handleTradeAccepted(
    leagueId: number,
    tradeId: number,
    completed: boolean,
    notifyLeagueChat?: boolean
  ): Promise<void> {
    const shouldNotify = await this.shouldNotifyLeagueChat(
      leagueId,
      completed ? 'trade_completed' : 'trade_accepted',
      notifyLeagueChat
    );
    if (!shouldNotify) return;

    const trade = await this.tradesRepo.findByIdWithDetails(tradeId);
    if (!trade) return;

    const messageType: MessageType = completed ? 'trade_completed' : 'trade_accepted';

    await this.systemMessageService.createAndBroadcast(leagueId, messageType, {
      tradeId,
      fromTeam: trade.proposerTeamName,
      toTeam: trade.recipientTeamName,
      fromRosterId: trade.proposerRosterId,
      toRosterId: trade.recipientRosterId,
    });
  }

  /**
   * Handle trade rejected event
   */
  async handleTradeRejected(
    leagueId: number,
    tradeId: number,
    notifyLeagueChat?: boolean
  ): Promise<void> {
    const shouldNotify = await this.shouldNotifyLeagueChat(
      leagueId,
      'trade_rejected',
      notifyLeagueChat
    );
    if (!shouldNotify) return;

    const trade = await this.tradesRepo.findByIdWithDetails(tradeId);
    if (!trade) return;

    await this.systemMessageService.createAndBroadcast(leagueId, 'trade_rejected', {
      tradeId,
      fromTeam: trade.proposerTeamName,
      toTeam: trade.recipientTeamName,
      fromRosterId: trade.proposerRosterId,
      toRosterId: trade.recipientRosterId,
    });
  }

  /**
   * Handle trade cancelled event
   */
  async handleTradeCancelled(
    leagueId: number,
    tradeId: number,
    notifyLeagueChat?: boolean
  ): Promise<void> {
    const shouldNotify = await this.shouldNotifyLeagueChat(
      leagueId,
      'trade_cancelled',
      notifyLeagueChat
    );
    if (!shouldNotify) return;

    const trade = await this.tradesRepo.findByIdWithDetails(tradeId);
    if (!trade) return;

    await this.systemMessageService.createAndBroadcast(leagueId, 'trade_cancelled', {
      tradeId,
      fromTeam: trade.proposerTeamName,
      toTeam: trade.recipientTeamName,
      fromRosterId: trade.proposerRosterId,
      toRosterId: trade.recipientRosterId,
    });
  }

  /**
   * Handle trade vetoed event
   */
  async handleTradeVetoed(leagueId: number, tradeId: number): Promise<void> {
    const shouldNotify = await this.shouldNotifyLeagueChat(leagueId, 'trade_vetoed');
    if (!shouldNotify) return;

    const trade = await this.tradesRepo.findByIdWithDetails(tradeId);
    if (!trade) return;

    await this.systemMessageService.createAndBroadcast(leagueId, 'trade_vetoed', {
      tradeId,
      fromTeam: trade.proposerTeamName,
      toTeam: trade.recipientTeamName,
      fromRosterId: trade.proposerRosterId,
      toRosterId: trade.recipientRosterId,
    });
  }

  /**
   * Handle trade countered event
   */
  async handleTradeCountered(
    leagueId: number,
    tradeId: number,
    options?: TradeNotificationOptions
  ): Promise<void> {
    const trade = await this.tradesRepo.findByIdWithDetails(tradeId);
    if (!trade) return;

    const league = await this.leagueRepo.findById(leagueId);
    if (!league) return;

    // Get commissioner settings for trade notifications
    const commMax =
      (league.leagueSettings?.tradeProposalLeagueChatMax as LeagueChatMode) || 'details';
    const commDefault =
      (league.leagueSettings?.tradeProposalLeagueChatDefault as LeagueChatMode) || 'summary';

    // Determine effective league chat mode
    const effectiveMode = getEffectiveLeagueChatMode(
      options?.leagueChatMode,
      options?.notifyLeagueChat,
      commMax,
      commDefault
    );

    // Handle league chat notification
    if (effectiveMode !== 'none') {
      const { details } = formatTradeForNotifications(trade);

      await this.systemMessageService.createAndBroadcast(leagueId, 'trade_countered', {
        tradeId,
        fromTeam: trade.proposerTeamName,
        toTeam: trade.recipientTeamName,
        fromRosterId: trade.proposerRosterId,
        toRosterId: trade.recipientRosterId,
        details: effectiveMode === 'details' ? details : undefined,
      });
    }

    // Handle DM notification (NOT capped by commissioner)
    // For counter, DM goes to original proposer (now recipient of counter)
    if (options?.notifyDm !== false) {
      await this.sendTradeDm(trade);
    }
  }

  /**
   * Handle trade invalidated event (player no longer available)
   */
  async handleTradeInvalidated(
    leagueId: number,
    tradeId: number,
    reason: string
  ): Promise<void> {
    const shouldNotify = await this.shouldNotifyLeagueChat(leagueId, 'trade_invalidated');
    if (!shouldNotify) return;

    const trade = await this.tradesRepo.findByIdWithDetails(tradeId);
    if (!trade) return;

    await this.systemMessageService.createAndBroadcast(leagueId, 'trade_invalidated', {
      tradeId,
      fromTeam: trade.proposerTeamName,
      toTeam: trade.recipientTeamName,
      fromRosterId: trade.proposerRosterId,
      toRosterId: trade.recipientRosterId,
      reason,
    });
  }

  /**
   * Handle successful waiver claim
   */
  async handleWaiverSuccessful(
    leagueId: number,
    teamName: string,
    playerName: string,
    bidAmount?: number
  ): Promise<void> {
    const shouldNotify = await this.shouldNotifyLeagueChat(leagueId, 'waiver_successful');
    if (!shouldNotify) return;

    await this.systemMessageService.createAndBroadcast(leagueId, 'waiver_successful', {
      teamName,
      playerName,
      bidAmount,
    });
  }

  /**
   * Handle waiver processing completed
   */
  async handleWaiverProcessed(leagueId: number): Promise<void> {
    const shouldNotify = await this.shouldNotifyLeagueChat(leagueId, 'waiver_processed');
    if (!shouldNotify) return;

    await this.systemMessageService.createAndBroadcast(leagueId, 'waiver_processed', {});
  }

  /**
   * Handle league settings updated
   */
  async handleSettingsUpdated(leagueId: number, settingName: string): Promise<void> {
    const shouldNotify = await this.shouldNotifyLeagueChat(leagueId, 'settings_updated');
    if (!shouldNotify) return;

    await this.systemMessageService.createAndBroadcast(leagueId, 'settings_updated', {
      settingName,
    });
  }

  /**
   * Handle member joined league
   */
  async handleMemberJoined(leagueId: number, teamName: string): Promise<void> {
    const shouldNotify = await this.shouldNotifyLeagueChat(leagueId, 'member_joined');
    if (!shouldNotify) return;

    await this.systemMessageService.createAndBroadcast(leagueId, 'member_joined', {
      teamName,
    });
  }

  /**
   * Handle member kicked from league
   */
  async handleMemberKicked(leagueId: number, teamName: string): Promise<void> {
    const shouldNotify = await this.shouldNotifyLeagueChat(leagueId, 'member_kicked');
    if (!shouldNotify) return;

    await this.systemMessageService.createAndBroadcast(leagueId, 'member_kicked', {
      teamName,
    });
  }

  /**
   * Check if a system message should be sent to league chat
   * based on league settings and optional user preference
   */
  private async shouldNotifyLeagueChat(
    leagueId: number,
    messageType: MessageType,
    userPreference?: boolean
  ): Promise<boolean> {
    const league = await this.leagueRepo.findById(leagueId);
    if (!league) return false;

    // Get system message settings from league
    const systemMessageSettings = league.settings?.system_messages || {};
    const policy: NotificationPolicy = systemMessageSettings[messageType] || 'always';

    switch (policy) {
      case 'always':
        return true;
      case 'never':
        return false;
      case 'user_choice':
        // Default to true if no user preference specified
        return userPreference !== false;
      default:
        return true;
    }
  }

  /**
   * Send a DM notification for a trade proposal/counter.
   * Message is sent from proposer to recipient.
   */
  private async sendTradeDm(trade: TradeWithDetails): Promise<void> {
    if (!this.dmService) return;

    // Get user IDs from rosters
    const proposerRoster = await this.rosterRepo.findById(trade.proposerRosterId);
    const recipientRoster = await this.rosterRepo.findById(trade.recipientRosterId);

    if (!proposerRoster?.userId || !recipientRoster?.userId) {
      logger.warn('Cannot send trade DM: missing user IDs', {
        tradeId: trade.id,
        proposerRosterId: trade.proposerRosterId,
        recipientRosterId: trade.recipientRosterId,
      });
      return;
    }

    const { summary, details } = formatTradeForNotifications(trade);
    const dmMessage = `${summary}\n\n${details}`;

    try {
      // Get or create conversation between proposer and recipient
      const conversation = await this.dmService.getOrCreateConversation(
        proposerRoster.userId,
        recipientRoster.userId
      );

      // Send the message as the proposer
      await this.dmService.sendMessage(proposerRoster.userId, conversation.id, dmMessage);
    } catch (err) {
      // Log but don't fail the trade
      logger.warn('Failed to send trade DM', {
        tradeId: trade.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
