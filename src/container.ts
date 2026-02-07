type Factory<T> = () => T;

class Container {
  private factories = new Map<string, Factory<unknown>>();
  private instances = new Map<string, unknown>();

  register<T>(key: string, factory: Factory<T>): void {
    this.factories.set(key, factory);
  }

  resolve<T>(key: string): T {
    // Return cached instance if exists
    if (this.instances.has(key)) {
      return this.instances.get(key) as T;
    }

    // Create new instance
    const factory = this.factories.get(key);
    if (!factory) {
      throw new Error(`No factory registered for key: ${key}`);
    }

    const instance = factory() as T;
    this.instances.set(key, instance);
    return instance;
  }

  // For testing: clear all instances
  clearInstances(): void {
    this.instances.clear();
  }

  // For testing: override with mock
  override<T>(key: string, instance: T): void {
    this.instances.set(key, instance);
  }
}

export const container = new Container();

export const KEYS = {
  // Database
  POOL: 'pool',

  // Repositories
  USER_REPO: 'userRepo',
  LEAGUE_REPO: 'leagueRepo',
  ROSTER_REPO: 'rosterRepo',
  DRAFT_REPO: 'draftRepo',
  CHAT_REPO: 'chatRepo',
  DM_REPO: 'dmRepo',
  PLAYER_REPO: 'playerRepo',
  ROSTER_PLAYERS_REPO: 'rosterPlayersRepo',
  ROSTER_TRANSACTIONS_REPO: 'rosterTransactionsRepo',
  LINEUPS_REPO: 'lineupsRepo',
  PLAYER_STATS_REPO: 'playerStatsRepo',
  MATCHUPS_REPO: 'matchupsRepo',
  TRADES_REPO: 'tradesRepo',
  TRADE_ITEMS_REPO: 'tradeItemsRepo',
  TRADE_VOTES_REPO: 'tradeVotesRepo',
  WAIVER_PRIORITY_REPO: 'waiverPriorityRepo',
  FAAB_BUDGET_REPO: 'faabBudgetRepo',
  WAIVER_CLAIMS_REPO: 'waiverClaimsRepo',
  WAIVER_WIRE_REPO: 'waiverWireRepo',
  PLAYOFF_REPO: 'playoffRepo',
  INVITATIONS_REPO: 'invitationsRepo',
  DUES_REPO: 'duesRepo',

  // Services
  AUTH_SERVICE: 'authService',
  AUTHORIZATION_SERVICE: 'authorizationService',
  LEAGUE_SERVICE: 'leagueService',
  ROSTER_SERVICE: 'rosterService',
  ROSTER_PLAYER_SERVICE: 'rosterPlayerService',
  LINEUP_SERVICE: 'lineupService',
  SCORING_SERVICE: 'scoringService',
  SCHEDULE_GENERATOR_SERVICE: 'scheduleGeneratorService',
  STANDINGS_SERVICE: 'standingsService',
  MATCHUP_SERVICE: 'matchupService',
  MEDIAN_SERVICE: 'medianService',
  DRAFT_SERVICE: 'draftService',
  DRAFT_ORDER_SERVICE: 'draftOrderService',
  DRAFT_PICK_SERVICE: 'draftPickService',
  DRAFT_STATE_SERVICE: 'draftStateService',
  DRAFT_QUEUE_SERVICE: 'draftQueueService',
  AUCTION_LOT_REPO: 'auctionLotRepo',
  PICK_ASSET_REPO: 'pickAssetRepo',
  VET_PICK_SELECTION_REPO: 'vetPickSelectionRepo',
  SLOW_AUCTION_SERVICE: 'slowAuctionService',
  FAST_AUCTION_SERVICE: 'fastAuctionService',
  DERBY_REPO: 'derbyRepo',
  DERBY_SERVICE: 'derbyService',
  CHAT_SERVICE: 'chatService',
  DM_SERVICE: 'dmService',
  PLAYER_SERVICE: 'playerService',
  SOCKET_SERVICE: 'socketService',
  TRADES_SERVICE: 'tradesService',
  WAIVERS_SERVICE: 'waiversService',
  STATS_SERVICE: 'statsService',
  PLAYOFF_SERVICE: 'playoffService',
  INVITATIONS_SERVICE: 'invitationsService',
  DUES_SERVICE: 'duesService',
  ROSTER_MUTATION_SERVICE: 'rosterMutationService',

  // Engines
  DRAFT_ENGINE_FACTORY: 'draftEngineFactory',

  // External Clients
  SLEEPER_CLIENT: 'sleeperClient',
  CFBD_CLIENT: 'cfbdClient',

  // System Messages
  SYSTEM_MESSAGE_SERVICE: 'systemMessageService',
  EVENT_LISTENER_SERVICE: 'eventListenerService',

  // Helpers
  LOCK_HELPER: 'lockHelper',
};
