// Ensure env is loaded before accessing process.env
import './config/env.config';

import { container, KEYS } from './container';
import { pool } from './db/pool';

// Repositories
import { UserRepository } from './modules/auth/auth.repository';
import { LeagueRepository, RosterRepository } from './modules/leagues/leagues.repository';
import { DraftRepository } from './modules/drafts/drafts.repository';
import { ChatRepository } from './modules/chat/chat.repository';
import { ChatReactionRepository } from './modules/chat/chat-reaction.repository';
import { DmRepository } from './modules/dm/dm.repository';
import { DmReactionRepository } from './modules/dm/dm-reaction.repository';
import { PlayerRepository } from './modules/players/players.repository';
import {
  RosterPlayersRepository,
  RosterTransactionsRepository,
} from './modules/rosters/rosters.repository';
import { LineupsRepository } from './modules/lineups/lineups.repository';
import { PlayerStatsRepository } from './modules/scoring/scoring.repository';
import { PlayerProjectionsRepository } from './modules/scoring/projections.repository';
import { GameProgressService } from './modules/scoring/game-progress.service';
import { MatchupsRepository } from './modules/matchups/matchups.repository';
import {
  TradesRepository,
  TradeItemsRepository,
  TradeVotesRepository,
} from './modules/trades/trades.repository';
import {
  WaiverPriorityRepository,
  FaabBudgetRepository,
  WaiverClaimsRepository,
  WaiverWireRepository,
  WaiverProcessingRunsRepository,
} from './modules/waivers/waivers.repository';

// Services
import { AuthService } from './modules/auth/auth.service';
import { AuthorizationService } from './modules/auth/authorization.service';
import { LeagueService } from './modules/leagues/leagues.service';
import { DashboardService } from './modules/leagues/dashboard.service';
import { RosterService } from './modules/leagues/roster.service';
import { DraftService } from './modules/drafts/drafts.service';
import { DraftOrderService } from './modules/drafts/draft-order.service';
import { DraftPickService } from './modules/drafts/draft-pick.service';
import { DraftStateService } from './modules/drafts/draft-state.service';
import { DraftQueueService } from './modules/drafts/draft-queue.service';
import { AuctionLotRepository } from './modules/drafts/auction/auction-lot.repository';
import { DraftPickAssetRepository } from './modules/drafts/draft-pick-asset.repository';
import { DraftChessClockRepository } from './modules/drafts/repositories/draft-chess-clock.repository';
import { VetDraftPickSelectionRepository } from './modules/drafts/vet-draft-pick-selection.repository';
import { DerbyRepository } from './modules/drafts/derby/derby.repository';
import { DerbyService } from './modules/drafts/derby/derby.service';
import { SlowAuctionService } from './modules/drafts/auction/slow-auction.service';
import { FastAuctionService } from './modules/drafts/auction/fast-auction.service';
import { ChatService } from './modules/chat/chat.service';
import { SystemMessageService } from './modules/chat/system-message.service';
import { EventListenerService } from './modules/chat/event-listener.service';
import { DmService } from './modules/dm/dm.service';
import { PlayerService } from './modules/players/players.service';
import { SleeperApiClient } from './integrations/sleeper/sleeper-api-client';
import { CFBDApiClient } from './modules/players/cfbd.client';
import { ExternalIdRepository } from './modules/players/external-ids.repository';
import { StatsProviderFactory } from './integrations/provider-factory';
import { RosterService as RosterPlayerService } from './modules/rosters/rosters.service';
import { RosterMutationService } from './modules/rosters/roster-mutation.service';
import { RosterRulesService } from './modules/rosters/roster-rules.service';
import { LineupService } from './modules/lineups/lineups.service';
import { ScoringService } from './modules/scoring/scoring.service';
import { StatsService } from './modules/scoring/stats.service';
import { MatchupService } from './modules/matchups/matchups.service';
import { ScheduleGeneratorService } from './modules/matchups/schedule-generator.service';
import { StandingsService } from './modules/matchups/standings.service';
import { MedianService } from './modules/matchups/median.service';
import { TradesService } from './modules/trades/trades.service';
import { WaiversService } from './modules/waivers/waivers.service';
import { PlayoffRepository } from './modules/playoffs/playoff.repository';
import { PlayoffService } from './modules/playoffs/playoff.service';
import { InvitationsRepository } from './modules/invitations/invitations.repository';
import { InvitationsService } from './modules/invitations/invitations.service';
import { DuesRepository } from './modules/dues/dues.repository';
import { DuesService } from './modules/dues/dues.service';
import { BestballService } from './modules/bestball/bestball.service';
import { TradeBlockRepository } from './modules/trade-block/trade-block.repository';
import { TradeBlockService } from './modules/trade-block/trade-block.service';
import { CommissionerToolsService } from './modules/commissioner-tools/commissioner-tools.service';

// Engines
import { DraftEngineFactory } from './engines';

// Helpers
import { LockHelper } from './shared/locks';

// Infrastructure
import { LeaderLock } from './shared/leader-lock';
import { DomainEventBus, SocketEventSubscriber, NotificationEventSubscriber } from './shared/events';
import { NotificationService } from './modules/notifications/notification.service';
import { initFirebase } from './shared/firebase';
import { CommandBus, registerAllHandlers } from './domain';

function bootstrap(): void {
  // Database
  container.register(KEYS.POOL, () => pool);

  // Repositories
  container.register(KEYS.USER_REPO, () => new UserRepository(container.resolve(KEYS.POOL)));
  container.register(KEYS.LEAGUE_REPO, () => new LeagueRepository(container.resolve(KEYS.POOL)));
  container.register(KEYS.ROSTER_REPO, () => new RosterRepository(container.resolve(KEYS.POOL)));
  container.register(KEYS.DRAFT_REPO, () => new DraftRepository(container.resolve(KEYS.POOL)));
  container.register(KEYS.CHAT_REPO, () => new ChatRepository(container.resolve(KEYS.POOL)));
  container.register(KEYS.CHAT_REACTION_REPO, () => new ChatReactionRepository(container.resolve(KEYS.POOL)));
  container.register(KEYS.DM_REPO, () => new DmRepository(container.resolve(KEYS.POOL)));
  container.register(KEYS.DM_REACTION_REPO, () => new DmReactionRepository(container.resolve(KEYS.POOL)));
  container.register(KEYS.PLAYER_REPO, () => new PlayerRepository(container.resolve(KEYS.POOL)));
  container.register(
    KEYS.ROSTER_PLAYERS_REPO,
    () => new RosterPlayersRepository(container.resolve(KEYS.POOL))
  );
  container.register(
    KEYS.ROSTER_TRANSACTIONS_REPO,
    () => new RosterTransactionsRepository(container.resolve(KEYS.POOL))
  );
  container.register(KEYS.LINEUPS_REPO, () => new LineupsRepository(container.resolve(KEYS.POOL)));
  container.register(
    KEYS.PLAYER_STATS_REPO,
    () => new PlayerStatsRepository(container.resolve(KEYS.POOL))
  );
  container.register(
    KEYS.PLAYER_PROJECTIONS_REPO,
    () => new PlayerProjectionsRepository(container.resolve(KEYS.POOL))
  );
  container.register(
    KEYS.MATCHUPS_REPO,
    () => new MatchupsRepository(container.resolve(KEYS.POOL))
  );
  container.register(KEYS.TRADES_REPO, () => new TradesRepository(container.resolve(KEYS.POOL)));
  container.register(
    KEYS.TRADE_ITEMS_REPO,
    () => new TradeItemsRepository(container.resolve(KEYS.POOL))
  );
  container.register(
    KEYS.TRADE_VOTES_REPO,
    () => new TradeVotesRepository(container.resolve(KEYS.POOL))
  );

  // Dues repository (needed by RosterService)
  container.register(
    KEYS.DUES_REPO,
    () => new DuesRepository(container.resolve(KEYS.POOL))
  );

  // Stats Provider (singleton per app instance)
  container.register(KEYS.STATS_PROVIDER, () => {
    const providerType = StatsProviderFactory.getDefaultProviderType();
    return StatsProviderFactory.createProvider(providerType);
  });

  // External ID Repository
  container.register(
    KEYS.EXTERNAL_ID_REPO,
    () => new ExternalIdRepository(container.resolve(KEYS.POOL))
  );

  // External Clients (legacy - for backward compatibility)
  container.register(KEYS.SLEEPER_CLIENT, () => new SleeperApiClient());

  // CFBD Client - only register if API key is configured
  container.register(KEYS.CFBD_CLIENT, () => {
    const apiKey = process.env.CFBD_API_KEY;
    if (apiKey) {
      return new CFBDApiClient(apiKey);
    }
    return null;
  });

  // Services
  container.register(KEYS.AUTH_SERVICE, () => new AuthService(container.resolve(KEYS.USER_REPO)));

  container.register(
    KEYS.AUTHORIZATION_SERVICE,
    () =>
      new AuthorizationService(
        container.resolve(KEYS.ROSTER_REPO),
        container.resolve(KEYS.LEAGUE_REPO)
      )
  );

  // System message services (must be registered before RosterService and LeagueService which depend on them)
  container.register(
    KEYS.SYSTEM_MESSAGE_SERVICE,
    () => new SystemMessageService(container.resolve(KEYS.CHAT_REPO))
  );

  // DM service (needed by EVENT_LISTENER_SERVICE for trade DMs)
  container.register(
    KEYS.DM_SERVICE,
    () => new DmService(container.resolve(KEYS.DM_REPO), container.resolve(KEYS.USER_REPO))
  );

  container.register(
    KEYS.EVENT_LISTENER_SERVICE,
    () =>
      new EventListenerService(
        container.resolve(KEYS.SYSTEM_MESSAGE_SERVICE),
        container.resolve(KEYS.TRADES_REPO),
        container.resolve(KEYS.ROSTER_REPO),
        container.resolve(KEYS.LEAGUE_REPO),
        container.resolve(KEYS.DM_SERVICE)
      )
  );

  container.register(
    KEYS.ROSTER_SERVICE,
    () =>
      new RosterService(
        container.resolve(KEYS.POOL),
        container.resolve(KEYS.LEAGUE_REPO),
        container.resolve(KEYS.ROSTER_REPO),
        container.resolve(KEYS.USER_REPO),
        container.resolve(KEYS.ROSTER_PLAYERS_REPO),
        container.resolve(KEYS.EVENT_LISTENER_SERVICE),
        container.resolve(KEYS.DUES_REPO),
        container.resolve(KEYS.WAIVER_PRIORITY_REPO),
        container.resolve(KEYS.FAAB_BUDGET_REPO)
      )
  );

  // Draft services (registered before LeagueService since it depends on DraftService)
  container.register(
    KEYS.DRAFT_ORDER_SERVICE,
    () =>
      new DraftOrderService(
        container.resolve(KEYS.POOL),
        container.resolve(KEYS.DRAFT_REPO),
        container.resolve(KEYS.LEAGUE_REPO),
        container.resolve(KEYS.ROSTER_REPO)
      )
  );

  // Engines (needed by DraftPickService)
  container.register(
    KEYS.DRAFT_ENGINE_FACTORY,
    () =>
      new DraftEngineFactory(
        container.resolve(KEYS.DRAFT_REPO),
        container.resolve(KEYS.PLAYER_REPO),
        container.resolve(KEYS.ROSTER_PLAYERS_REPO),
        container.resolve(KEYS.LEAGUE_REPO),
        container.resolve(KEYS.ROSTER_REPO)
      )
  );

  container.register(
    KEYS.DRAFT_PICK_SERVICE,
    () =>
      new DraftPickService(
        container.resolve(KEYS.DRAFT_REPO),
        container.resolve(KEYS.LEAGUE_REPO),
        container.resolve(KEYS.ROSTER_REPO),
        container.resolve(KEYS.DRAFT_ENGINE_FACTORY),
        container.resolve(KEYS.PLAYER_REPO),
        container.resolve(KEYS.ROSTER_PLAYERS_REPO),
        container.resolve(KEYS.PICK_ASSET_REPO),
        container.resolve(KEYS.VET_PICK_SELECTION_REPO)
      )
  );

  // Register SCHEDULE_GENERATOR_SERVICE before DRAFT_STATE_SERVICE (which depends on it)
  container.register(
    KEYS.SCHEDULE_GENERATOR_SERVICE,
    () =>
      new ScheduleGeneratorService(
        container.resolve(KEYS.POOL),
        container.resolve(KEYS.MATCHUPS_REPO),
        container.resolve(KEYS.ROSTER_REPO),
        container.resolve(KEYS.LEAGUE_REPO)
      )
  );

  container.register(
    KEYS.DRAFT_STATE_SERVICE,
    () =>
      new DraftStateService(
        container.resolve(KEYS.POOL),
        container.resolve(KEYS.DRAFT_REPO),
        container.resolve(KEYS.LEAGUE_REPO),
        container.resolve(KEYS.DRAFT_ENGINE_FACTORY),
        container.resolve(KEYS.ROSTER_PLAYERS_REPO),
        container.resolve(KEYS.SCHEDULE_GENERATOR_SERVICE),
        container.resolve(KEYS.PICK_ASSET_REPO)
      )
  );

  container.register(
    KEYS.DRAFT_SERVICE,
    () =>
      new DraftService(
        container.resolve(KEYS.DRAFT_REPO),
        container.resolve(KEYS.LEAGUE_REPO),
        container.resolve(KEYS.ROSTER_REPO),
        container.resolve(KEYS.DRAFT_ORDER_SERVICE),
        container.resolve(KEYS.DRAFT_PICK_SERVICE),
        container.resolve(KEYS.DRAFT_STATE_SERVICE),
        container.resolve(KEYS.PICK_ASSET_REPO)
      )
  );

  container.register(
    KEYS.LEAGUE_SERVICE,
    () =>
      new LeagueService(
        pool,
        container.resolve(KEYS.LEAGUE_REPO),
        container.resolve(KEYS.ROSTER_REPO),
        container.resolve(KEYS.ROSTER_SERVICE),
        container.resolve(KEYS.DRAFT_SERVICE),
        container.resolve(KEYS.EVENT_LISTENER_SERVICE),
        container.resolve(KEYS.MATCHUPS_REPO)
      )
  );

  container.register(
    KEYS.DASHBOARD_SERVICE,
    () =>
      new DashboardService(
        container.resolve(KEYS.POOL),
        container.resolve(KEYS.LEAGUE_REPO),
        container.resolve(KEYS.ROSTER_REPO)
      )
  );

  container.register(
    KEYS.DRAFT_QUEUE_SERVICE,
    () =>
      new DraftQueueService(
        container.resolve(KEYS.DRAFT_REPO),
        container.resolve(KEYS.PLAYER_REPO),
        container.resolve(KEYS.ROSTER_REPO)
      )
  );

  container.register(
    KEYS.AUCTION_LOT_REPO,
    () => new AuctionLotRepository(container.resolve(KEYS.POOL))
  );

  container.register(
    KEYS.PICK_ASSET_REPO,
    () => new DraftPickAssetRepository(container.resolve(KEYS.POOL))
  );

  container.register(
    KEYS.VET_PICK_SELECTION_REPO,
    () => new VetDraftPickSelectionRepository(container.resolve(KEYS.POOL))
  );

  container.register(
    KEYS.CHESS_CLOCK_REPO,
    () => new DraftChessClockRepository(container.resolve(KEYS.POOL))
  );

  // Derby (draft order selection mode)
  container.register(
    KEYS.DERBY_REPO,
    () => new DerbyRepository(container.resolve(KEYS.POOL))
  );

  container.register(
    KEYS.DERBY_SERVICE,
    () =>
      new DerbyService(
        container.resolve(KEYS.POOL),
        container.resolve(KEYS.DERBY_REPO),
        container.resolve(KEYS.DRAFT_REPO),
        container.resolve(KEYS.LEAGUE_REPO),
        container.resolve(KEYS.ROSTER_REPO),
        container.resolve(KEYS.PICK_ASSET_REPO)
      )
  );

  container.register(
    KEYS.SLOW_AUCTION_SERVICE,
    () =>
      new SlowAuctionService(
        container.resolve(KEYS.AUCTION_LOT_REPO),
        container.resolve(KEYS.DRAFT_REPO),
        container.resolve(KEYS.ROSTER_REPO),
        container.resolve(KEYS.LEAGUE_REPO),
        container.resolve(KEYS.PLAYER_REPO),
        container.resolve(KEYS.POOL)
      )
  );

  container.register(
    KEYS.FAST_AUCTION_SERVICE,
    () =>
      new FastAuctionService(
        container.resolve(KEYS.AUCTION_LOT_REPO),
        container.resolve(KEYS.DRAFT_REPO),
        container.resolve(KEYS.ROSTER_REPO),
        container.resolve(KEYS.LEAGUE_REPO),
        container.resolve(KEYS.DRAFT_ORDER_SERVICE),
        container.resolve(KEYS.PLAYER_REPO),
        container.resolve(KEYS.POOL)
      )
  );

  container.register(
    KEYS.CHAT_SERVICE,
    () => new ChatService(container.resolve(KEYS.CHAT_REPO), container.resolve(KEYS.LEAGUE_REPO))
  );

  container.register(
    KEYS.PLAYER_SERVICE,
    () =>
      new PlayerService(
        container.resolve(KEYS.PLAYER_REPO),
        container.resolve(KEYS.EXTERNAL_ID_REPO),
        container.resolve(KEYS.STATS_PROVIDER),
        container.resolve(KEYS.CFBD_CLIENT)
      )
  );

  // Waiver repositories (needed by roster service for waiver wire integration)
  container.register(
    KEYS.WAIVER_PRIORITY_REPO,
    () => new WaiverPriorityRepository(container.resolve(KEYS.POOL))
  );
  container.register(
    KEYS.FAAB_BUDGET_REPO,
    () => new FaabBudgetRepository(container.resolve(KEYS.POOL))
  );
  container.register(
    KEYS.WAIVER_CLAIMS_REPO,
    () => new WaiverClaimsRepository(container.resolve(KEYS.POOL))
  );
  container.register(
    KEYS.WAIVER_WIRE_REPO,
    () => new WaiverWireRepository(container.resolve(KEYS.POOL))
  );
  container.register(
    KEYS.WAIVER_PROCESSING_RUNS_REPO,
    () => new WaiverProcessingRunsRepository(container.resolve(KEYS.POOL))
  );
  container.register(KEYS.PLAYOFF_REPO, () => new PlayoffRepository(container.resolve(KEYS.POOL)));

  // Roster mutation service (centralized validation for roster changes)
  container.register(
    KEYS.ROSTER_MUTATION_SERVICE,
    () =>
      new RosterMutationService(
        container.resolve(KEYS.ROSTER_PLAYERS_REPO),
        container.resolve(KEYS.LEAGUE_REPO)
      )
  );

  // Roster rules validator (unified validation for roster state transitions)
  container.register(
    KEYS.ROSTER_RULES_SERVICE,
    () =>
      new RosterRulesService(
        container.resolve(KEYS.ROSTER_PLAYERS_REPO),
        container.resolve(KEYS.LEAGUE_REPO),
        container.resolve(KEYS.PICK_ASSET_REPO)
      )
  );

  // Season management services
  container.register(
    KEYS.ROSTER_PLAYER_SERVICE,
    () =>
      new RosterPlayerService(
        container.resolve(KEYS.POOL),
        container.resolve(KEYS.ROSTER_PLAYERS_REPO),
        container.resolve(KEYS.ROSTER_TRANSACTIONS_REPO),
        container.resolve(KEYS.ROSTER_REPO),
        container.resolve(KEYS.LEAGUE_REPO),
        container.resolve(KEYS.WAIVER_WIRE_REPO),
        container.resolve(KEYS.ROSTER_MUTATION_SERVICE),
        container.resolve(KEYS.EVENT_LISTENER_SERVICE),
        container.resolve(KEYS.PLAYER_REPO)
      )
  );

  container.register(
    KEYS.LINEUP_SERVICE,
    () =>
      new LineupService(
        container.resolve(KEYS.POOL),
        container.resolve(KEYS.LINEUPS_REPO),
        container.resolve(KEYS.ROSTER_PLAYERS_REPO),
        container.resolve(KEYS.ROSTER_REPO),
        container.resolve(KEYS.LEAGUE_REPO)
      )
  );

  // Game progress service for live scoring
  container.register(KEYS.GAME_PROGRESS_SERVICE, () => new GameProgressService());

  container.register(KEYS.SCORING_SERVICE, () => {
    const scoringService = new ScoringService(
      container.resolve(KEYS.POOL),
      container.resolve(KEYS.PLAYER_STATS_REPO),
      container.resolve(KEYS.LINEUPS_REPO),
      container.resolve(KEYS.LEAGUE_REPO)
    );

    // Configure live scoring dependencies
    scoringService.configureLiveScoring(
      container.resolve(KEYS.PLAYER_PROJECTIONS_REPO),
      container.resolve(KEYS.PLAYER_REPO),
      container.resolve(KEYS.GAME_PROGRESS_SERVICE)
    );

    return scoringService;
  });

  container.register(
    KEYS.STATS_SERVICE,
    () =>
      new StatsService(
        container.resolve(KEYS.STATS_PROVIDER),
        container.resolve(KEYS.PLAYER_STATS_REPO),
        container.resolve(KEYS.EXTERNAL_ID_REPO),
        container.resolve(KEYS.PLAYER_PROJECTIONS_REPO)
      )
  );

  container.register(
    KEYS.STANDINGS_SERVICE,
    () =>
      new StandingsService(
        container.resolve(KEYS.MATCHUPS_REPO),
        container.resolve(KEYS.LEAGUE_REPO)
      )
  );

  container.register(
    KEYS.MEDIAN_SERVICE,
    () =>
      new MedianService(
        container.resolve(KEYS.POOL),
        container.resolve(KEYS.LINEUPS_REPO),
        container.resolve(KEYS.LEAGUE_REPO),
        container.resolve(KEYS.MATCHUPS_REPO)
      )
  );

  container.register(
    KEYS.MATCHUP_SERVICE,
    () =>
      new MatchupService(
        container.resolve(KEYS.POOL),
        container.resolve(KEYS.MATCHUPS_REPO),
        container.resolve(KEYS.LINEUPS_REPO),
        container.resolve(KEYS.ROSTER_REPO),
        container.resolve(KEYS.LEAGUE_REPO),
        container.resolve(KEYS.SCORING_SERVICE),
        container.resolve(KEYS.PLAYER_REPO),
        container.resolve(KEYS.PLAYER_STATS_REPO),
        container.resolve(KEYS.PLAYER_PROJECTIONS_REPO),
        container.resolve(KEYS.MEDIAN_SERVICE),
        container.resolve(KEYS.GAME_PROGRESS_SERVICE),
        container.resolve(KEYS.BESTBALL_SERVICE)
      )
  );

  container.register(
    KEYS.TRADES_SERVICE,
    () =>
      new TradesService(
        container.resolve(KEYS.POOL),
        container.resolve(KEYS.TRADES_REPO),
        container.resolve(KEYS.TRADE_ITEMS_REPO),
        container.resolve(KEYS.TRADE_VOTES_REPO),
        container.resolve(KEYS.ROSTER_REPO),
        container.resolve(KEYS.ROSTER_PLAYERS_REPO),
        container.resolve(KEYS.ROSTER_TRANSACTIONS_REPO),
        container.resolve(KEYS.LEAGUE_REPO),
        container.resolve(KEYS.PLAYER_REPO),
        container.resolve(KEYS.ROSTER_MUTATION_SERVICE),
        container.resolve(KEYS.EVENT_LISTENER_SERVICE),
        container.resolve(KEYS.PICK_ASSET_REPO)
      )
  );

  // Trade block
  container.register(
    KEYS.TRADE_BLOCK_REPO,
    () => new TradeBlockRepository(container.resolve(KEYS.POOL))
  );
  container.register(
    KEYS.TRADE_BLOCK_SERVICE,
    () =>
      new TradeBlockService(
        container.resolve(KEYS.POOL),
        container.resolve(KEYS.TRADE_BLOCK_REPO),
        container.resolve(KEYS.ROSTER_REPO),
        container.resolve(KEYS.ROSTER_PLAYERS_REPO)
      )
  );

  // Waiver service
  container.register(
    KEYS.WAIVERS_SERVICE,
    () =>
      new WaiversService(
        container.resolve(KEYS.POOL),
        container.resolve(KEYS.WAIVER_PRIORITY_REPO),
        container.resolve(KEYS.FAAB_BUDGET_REPO),
        container.resolve(KEYS.WAIVER_CLAIMS_REPO),
        container.resolve(KEYS.WAIVER_WIRE_REPO),
        container.resolve(KEYS.ROSTER_REPO),
        container.resolve(KEYS.ROSTER_PLAYERS_REPO),
        container.resolve(KEYS.ROSTER_TRANSACTIONS_REPO),
        container.resolve(KEYS.LEAGUE_REPO),
        container.resolve(KEYS.TRADES_REPO),
        container.resolve(KEYS.EVENT_LISTENER_SERVICE),
        container.resolve(KEYS.ROSTER_MUTATION_SERVICE),
        container.resolve(KEYS.WAIVER_PROCESSING_RUNS_REPO)
      )
  );

  // Playoff service
  container.register(
    KEYS.PLAYOFF_SERVICE,
    () =>
      new PlayoffService(
        container.resolve(KEYS.POOL),
        container.resolve(KEYS.PLAYOFF_REPO),
        container.resolve(KEYS.MATCHUPS_REPO),
        container.resolve(KEYS.LEAGUE_REPO)
      )
  );

  // Invitations
  container.register(
    KEYS.INVITATIONS_REPO,
    () => new InvitationsRepository(container.resolve(KEYS.POOL))
  );

  container.register(
    KEYS.INVITATIONS_SERVICE,
    () =>
      new InvitationsService(
        container.resolve(KEYS.INVITATIONS_REPO),
        container.resolve(KEYS.LEAGUE_REPO),
        container.resolve(KEYS.ROSTER_REPO),
        container.resolve(KEYS.USER_REPO),
        container.resolve(KEYS.ROSTER_SERVICE)
      )
  );

  // Dues service
  container.register(
    KEYS.DUES_SERVICE,
    () =>
      new DuesService(
        container.resolve(KEYS.DUES_REPO),
        container.resolve(KEYS.LEAGUE_REPO),
        container.resolve(KEYS.ROSTER_REPO),
        container.resolve(KEYS.SYSTEM_MESSAGE_SERVICE)
      )
  );

  // Commissioner Tools
  container.register(
    KEYS.COMMISSIONER_TOOLS_SERVICE,
    () =>
      new CommissionerToolsService(
        container.resolve(KEYS.POOL),
        container.resolve(KEYS.AUTHORIZATION_SERVICE),
        container.resolve(KEYS.DRAFT_REPO),
        container.resolve(KEYS.CHESS_CLOCK_REPO),
        container.resolve(KEYS.DRAFT_STATE_SERVICE),
        container.resolve(KEYS.WAIVER_PRIORITY_REPO),
        container.resolve(KEYS.FAAB_BUDGET_REPO),
        container.resolve(KEYS.TRADES_REPO),
        container.resolve(KEYS.LEAGUE_REPO),
        container.resolve(KEYS.ROSTER_REPO),
        container.resolve(KEYS.DUES_SERVICE),
        container.resolve(KEYS.EVENT_LISTENER_SERVICE)
      )
  );

  // Helpers
  container.register(KEYS.LOCK_HELPER, () => new LockHelper());

  // Infrastructure - Leader Lock for job coordination
  container.register(KEYS.LEADER_LOCK, () => new LeaderLock(container.resolve(KEYS.POOL)));

  // Initialize Firebase Admin SDK for push notifications
  initFirebase();

  // Infrastructure - Domain Event Bus for decoupled socket emissions
  container.register(KEYS.DOMAIN_EVENT_BUS, () => {
    const eventBus = new DomainEventBus();
    // Register the socket subscriber to handle domain events
    eventBus.subscribe(new SocketEventSubscriber());
    // Register the notification subscriber for push notifications
    const notificationService = new NotificationService(container.resolve(KEYS.POOL));
    eventBus.subscribe(new NotificationEventSubscriber(container.resolve(KEYS.POOL), notificationService));
    return eventBus;
  });

  // Infrastructure - Command Bus for centralized domain mutations
  container.register(KEYS.COMMAND_BUS, () => {
    const commandBus = new CommandBus();
    // Register all command handlers
    registerAllHandlers(commandBus);
    return commandBus;
  });

  // Bestball service
  container.register(
    KEYS.BESTBALL_SERVICE,
    () =>
      new BestballService(
        container.resolve(KEYS.POOL),
        container.resolve(KEYS.LEAGUE_REPO),
        container.resolve(KEYS.ROSTER_REPO),
        container.resolve(KEYS.ROSTER_PLAYERS_REPO),
        container.resolve(KEYS.LINEUPS_REPO),
        container.resolve(KEYS.PLAYER_STATS_REPO),
        container.resolve(KEYS.PLAYER_PROJECTIONS_REPO),
        container.resolve(KEYS.PLAYER_REPO),
        container.resolve(KEYS.SCORING_SERVICE)
      )
  );
}

// Auto-run bootstrap when this module is imported
bootstrap();
