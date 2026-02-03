import { SystemMessageService } from './system-message.service';
import { TradesRepository } from '../trades/trades.repository';
import { RosterRepository, LeagueRepository } from '../leagues/leagues.repository';
import { MessageType } from './chat.model';

/**
 * Notification policy for system messages
 * - 'always': Always send to league chat
 * - 'never': Never send to league chat
 * - 'user_choice': Respect user preference per-trade
 */
export type NotificationPolicy = 'always' | 'never' | 'user_choice';

/**
 * Service for listening to league events and creating system messages
 */
export class EventListenerService {
  constructor(
    private readonly systemMessageService: SystemMessageService,
    private readonly tradesRepo: TradesRepository,
    private readonly rosterRepo: RosterRepository,
    private readonly leagueRepo: LeagueRepository
  ) {}

  /**
   * Handle trade proposed event
   */
  async handleTradeProposed(
    leagueId: number,
    tradeId: number,
    notifyLeagueChat?: boolean
  ): Promise<void> {
    const shouldNotify = await this.shouldNotifyLeagueChat(
      leagueId,
      'trade_proposed',
      notifyLeagueChat
    );
    if (!shouldNotify) return;

    const trade = await this.tradesRepo.findByIdWithDetails(tradeId);
    if (!trade) return;

    await this.systemMessageService.createAndBroadcast(leagueId, 'trade_proposed', {
      tradeId,
      fromTeam: trade.proposerTeamName,
      toTeam: trade.recipientTeamName,
      fromRosterId: trade.proposerRosterId,
      toRosterId: trade.recipientRosterId,
    });
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
    notifyLeagueChat?: boolean
  ): Promise<void> {
    const shouldNotify = await this.shouldNotifyLeagueChat(
      leagueId,
      'trade_countered',
      notifyLeagueChat
    );
    if (!shouldNotify) return;

    const trade = await this.tradesRepo.findByIdWithDetails(tradeId);
    if (!trade) return;

    await this.systemMessageService.createAndBroadcast(leagueId, 'trade_countered', {
      tradeId,
      fromTeam: trade.proposerTeamName,
      toTeam: trade.recipientTeamName,
      fromRosterId: trade.proposerRosterId,
      toRosterId: trade.recipientRosterId,
    });
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
}
