import { container, KEYS } from './container';
import { pool } from './db/pool';

// Repositories
import { UserRepository } from './modules/auth/auth.repository';
import { LeagueRepository, RosterRepository } from './modules/leagues/leagues.repository';
import { DraftRepository } from './modules/drafts/drafts.repository';
import { ChatRepository } from './modules/chat/chat.repository';
import { PlayerRepository } from './modules/players/players.repository';
import { RosterPlayersRepository, RosterTransactionsRepository } from './modules/rosters/rosters.repository';
import { LineupsRepository } from './modules/lineups/lineups.repository';
import { PlayerStatsRepository } from './modules/scoring/scoring.repository';
import { MatchupsRepository } from './modules/matchups/matchups.repository';
import { TradesRepository, TradeItemsRepository, TradeVotesRepository } from './modules/trades/trades.repository';
import { WaiverPriorityRepository, FaabBudgetRepository, WaiverClaimsRepository, WaiverWireRepository } from './modules/waivers/waivers.repository';

// Services
import { AuthService } from './modules/auth/auth.service';
import { AuthorizationService } from './modules/auth/authorization.service';
import { LeagueService } from './modules/leagues/leagues.service';
import { RosterService } from './modules/leagues/roster.service';
import { DraftService } from './modules/drafts/drafts.service';
import { DraftOrderService } from './modules/drafts/draft-order.service';
import { DraftPickService } from './modules/drafts/draft-pick.service';
import { DraftStateService } from './modules/drafts/draft-state.service';
import { DraftQueueService } from './modules/drafts/draft-queue.service';
import { AuctionLotRepository } from './modules/drafts/auction/auction-lot.repository';
import { SlowAuctionService } from './modules/drafts/auction/slow-auction.service';
import { FastAuctionService } from './modules/drafts/auction/fast-auction.service';
import { ChatService } from './modules/chat/chat.service';
import { PlayerService } from './modules/players/players.service';
import { SleeperApiClient } from './modules/players/sleeper.client';
import { RosterService as RosterPlayerService } from './modules/rosters/rosters.service';
import { LineupService } from './modules/lineups/lineups.service';
import { ScoringService } from './modules/scoring/scoring.service';
import { StatsService } from './modules/scoring/stats.service';
import { MatchupService } from './modules/matchups/matchups.service';
import { ScheduleGeneratorService } from './modules/matchups/schedule-generator.service';
import { StandingsService } from './modules/matchups/standings.service';
import { TradesService } from './modules/trades/trades.service';
import { WaiversService } from './modules/waivers/waivers.service';
import { PlayoffRepository } from './modules/playoffs/playoff.repository';
import { PlayoffService } from './modules/playoffs/playoff.service';
import { InvitationsRepository } from './modules/invitations/invitations.repository';
import { InvitationsService } from './modules/invitations/invitations.service';

// Engines
import { DraftEngineFactory } from './engines';

// Helpers
import { LockHelper } from './shared/locks';

function bootstrap(): void {
  // Database
  container.register(KEYS.POOL, () => pool);

  // Repositories
  container.register(KEYS.USER_REPO, () => new UserRepository(container.resolve(KEYS.POOL)));
  container.register(KEYS.LEAGUE_REPO, () => new LeagueRepository(container.resolve(KEYS.POOL)));
  container.register(KEYS.ROSTER_REPO, () => new RosterRepository(container.resolve(KEYS.POOL)));
  container.register(KEYS.DRAFT_REPO, () => new DraftRepository(container.resolve(KEYS.POOL)));
  container.register(KEYS.CHAT_REPO, () => new ChatRepository(container.resolve(KEYS.POOL)));
  container.register(KEYS.PLAYER_REPO, () => new PlayerRepository(container.resolve(KEYS.POOL)));
  container.register(KEYS.ROSTER_PLAYERS_REPO, () => new RosterPlayersRepository(container.resolve(KEYS.POOL)));
  container.register(KEYS.ROSTER_TRANSACTIONS_REPO, () => new RosterTransactionsRepository(container.resolve(KEYS.POOL)));
  container.register(KEYS.LINEUPS_REPO, () => new LineupsRepository(container.resolve(KEYS.POOL)));
  container.register(KEYS.PLAYER_STATS_REPO, () => new PlayerStatsRepository(container.resolve(KEYS.POOL)));
  container.register(KEYS.MATCHUPS_REPO, () => new MatchupsRepository(container.resolve(KEYS.POOL)));
  container.register(KEYS.TRADES_REPO, () => new TradesRepository(container.resolve(KEYS.POOL)));
  container.register(KEYS.TRADE_ITEMS_REPO, () => new TradeItemsRepository(container.resolve(KEYS.POOL)));
  container.register(KEYS.TRADE_VOTES_REPO, () => new TradeVotesRepository(container.resolve(KEYS.POOL)));

  // External Clients
  container.register(KEYS.SLEEPER_CLIENT, () => new SleeperApiClient());

  // Services
  container.register(KEYS.AUTH_SERVICE, () =>
    new AuthService(container.resolve(KEYS.USER_REPO))
  );

  container.register(KEYS.AUTHORIZATION_SERVICE, () =>
    new AuthorizationService(
      container.resolve(KEYS.ROSTER_REPO),
      container.resolve(KEYS.LEAGUE_REPO)
    )
  );

  container.register(KEYS.ROSTER_SERVICE, () =>
    new RosterService(
      container.resolve(KEYS.POOL),
      container.resolve(KEYS.LEAGUE_REPO),
      container.resolve(KEYS.ROSTER_REPO),
      container.resolve(KEYS.USER_REPO),
      container.resolve(KEYS.ROSTER_PLAYERS_REPO)
    )
  );

  container.register(KEYS.LEAGUE_SERVICE, () =>
    new LeagueService(
      container.resolve(KEYS.LEAGUE_REPO),
      container.resolve(KEYS.ROSTER_REPO),
      container.resolve(KEYS.ROSTER_SERVICE)
    )
  );

  container.register(KEYS.DRAFT_ORDER_SERVICE, () =>
    new DraftOrderService(
      container.resolve(KEYS.POOL),
      container.resolve(KEYS.DRAFT_REPO),
      container.resolve(KEYS.LEAGUE_REPO),
      container.resolve(KEYS.ROSTER_REPO)
    )
  );

  // Engines (needed by DraftPickService)
  container.register(KEYS.DRAFT_ENGINE_FACTORY, () =>
    new DraftEngineFactory(
      container.resolve(KEYS.DRAFT_REPO),
      container.resolve(KEYS.PLAYER_REPO),
      container.resolve(KEYS.ROSTER_PLAYERS_REPO),
      container.resolve(KEYS.LEAGUE_REPO),
      container.resolve(KEYS.ROSTER_REPO)
    )
  );

  container.register(KEYS.DRAFT_PICK_SERVICE, () =>
    new DraftPickService(
      container.resolve(KEYS.DRAFT_REPO),
      container.resolve(KEYS.LEAGUE_REPO),
      container.resolve(KEYS.ROSTER_REPO),
      container.resolve(KEYS.DRAFT_ENGINE_FACTORY),
      container.resolve(KEYS.PLAYER_REPO),
      container.resolve(KEYS.ROSTER_PLAYERS_REPO)
    )
  );

  container.register(KEYS.DRAFT_STATE_SERVICE, () =>
    new DraftStateService(
      container.resolve(KEYS.DRAFT_REPO),
      container.resolve(KEYS.LEAGUE_REPO),
      container.resolve(KEYS.DRAFT_ENGINE_FACTORY),
      container.resolve(KEYS.ROSTER_PLAYERS_REPO)
    )
  );

  container.register(KEYS.DRAFT_SERVICE, () =>
    new DraftService(
      container.resolve(KEYS.DRAFT_REPO),
      container.resolve(KEYS.LEAGUE_REPO),
      container.resolve(KEYS.ROSTER_REPO),
      container.resolve(KEYS.DRAFT_ORDER_SERVICE),
      container.resolve(KEYS.DRAFT_PICK_SERVICE),
      container.resolve(KEYS.DRAFT_STATE_SERVICE)
    )
  );

  container.register(KEYS.DRAFT_QUEUE_SERVICE, () =>
    new DraftQueueService(
      container.resolve(KEYS.DRAFT_REPO),
      container.resolve(KEYS.PLAYER_REPO),
      container.resolve(KEYS.ROSTER_REPO)
    )
  );

  container.register(KEYS.AUCTION_LOT_REPO, () =>
    new AuctionLotRepository(container.resolve(KEYS.POOL))
  );

  container.register(KEYS.SLOW_AUCTION_SERVICE, () =>
    new SlowAuctionService(
      container.resolve(KEYS.AUCTION_LOT_REPO),
      container.resolve(KEYS.DRAFT_REPO),
      container.resolve(KEYS.ROSTER_REPO),
      container.resolve(KEYS.LEAGUE_REPO),
      container.resolve(KEYS.PLAYER_REPO),
      container.resolve(KEYS.POOL)
    )
  );

  container.register(KEYS.FAST_AUCTION_SERVICE, () =>
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

  container.register(KEYS.CHAT_SERVICE, () =>
    new ChatService(
      container.resolve(KEYS.CHAT_REPO),
      container.resolve(KEYS.LEAGUE_REPO)
    )
  );

  container.register(KEYS.PLAYER_SERVICE, () =>
    new PlayerService(
      container.resolve(KEYS.PLAYER_REPO),
      container.resolve(KEYS.SLEEPER_CLIENT)
    )
  );

  // Waiver repositories (needed by roster service for waiver wire integration)
  container.register(KEYS.WAIVER_PRIORITY_REPO, () =>
    new WaiverPriorityRepository(container.resolve(KEYS.POOL))
  );
  container.register(KEYS.FAAB_BUDGET_REPO, () =>
    new FaabBudgetRepository(container.resolve(KEYS.POOL))
  );
  container.register(KEYS.WAIVER_CLAIMS_REPO, () =>
    new WaiverClaimsRepository(container.resolve(KEYS.POOL))
  );
  container.register(KEYS.WAIVER_WIRE_REPO, () =>
    new WaiverWireRepository(container.resolve(KEYS.POOL))
  );
  container.register(KEYS.PLAYOFF_REPO, () =>
    new PlayoffRepository(container.resolve(KEYS.POOL))
  );

  // Season management services
  container.register(KEYS.ROSTER_PLAYER_SERVICE, () =>
    new RosterPlayerService(
      container.resolve(KEYS.POOL),
      container.resolve(KEYS.ROSTER_PLAYERS_REPO),
      container.resolve(KEYS.ROSTER_TRANSACTIONS_REPO),
      container.resolve(KEYS.ROSTER_REPO),
      container.resolve(KEYS.LEAGUE_REPO),
      container.resolve(KEYS.WAIVER_WIRE_REPO)
    )
  );

  container.register(KEYS.LINEUP_SERVICE, () =>
    new LineupService(
      container.resolve(KEYS.POOL),
      container.resolve(KEYS.LINEUPS_REPO),
      container.resolve(KEYS.ROSTER_PLAYERS_REPO),
      container.resolve(KEYS.ROSTER_REPO),
      container.resolve(KEYS.LEAGUE_REPO)
    )
  );

  container.register(KEYS.SCORING_SERVICE, () =>
    new ScoringService(
      container.resolve(KEYS.POOL),
      container.resolve(KEYS.PLAYER_STATS_REPO),
      container.resolve(KEYS.LINEUPS_REPO),
      container.resolve(KEYS.LEAGUE_REPO)
    )
  );

  container.register(KEYS.STATS_SERVICE, () =>
    new StatsService(
      container.resolve(KEYS.SLEEPER_CLIENT),
      container.resolve(KEYS.PLAYER_STATS_REPO),
      container.resolve(KEYS.PLAYER_REPO)
    )
  );

  container.register(KEYS.SCHEDULE_GENERATOR_SERVICE, () =>
    new ScheduleGeneratorService(
      container.resolve(KEYS.POOL),
      container.resolve(KEYS.MATCHUPS_REPO),
      container.resolve(KEYS.ROSTER_REPO),
      container.resolve(KEYS.LEAGUE_REPO)
    )
  );

  container.register(KEYS.STANDINGS_SERVICE, () =>
    new StandingsService(
      container.resolve(KEYS.MATCHUPS_REPO),
      container.resolve(KEYS.LEAGUE_REPO)
    )
  );

  container.register(KEYS.MATCHUP_SERVICE, () =>
    new MatchupService(
      container.resolve(KEYS.POOL),
      container.resolve(KEYS.MATCHUPS_REPO),
      container.resolve(KEYS.LINEUPS_REPO),
      container.resolve(KEYS.ROSTER_REPO),
      container.resolve(KEYS.LEAGUE_REPO),
      container.resolve(KEYS.SCORING_SERVICE),
      container.resolve(KEYS.PLAYER_REPO),
      container.resolve(KEYS.PLAYER_STATS_REPO)
    )
  );

  container.register(KEYS.TRADES_SERVICE, () =>
    new TradesService(
      container.resolve(KEYS.POOL),
      container.resolve(KEYS.TRADES_REPO),
      container.resolve(KEYS.TRADE_ITEMS_REPO),
      container.resolve(KEYS.TRADE_VOTES_REPO),
      container.resolve(KEYS.ROSTER_REPO),
      container.resolve(KEYS.ROSTER_PLAYERS_REPO),
      container.resolve(KEYS.ROSTER_TRANSACTIONS_REPO),
      container.resolve(KEYS.LEAGUE_REPO)
    )
  );

  // Waiver service
  container.register(KEYS.WAIVERS_SERVICE, () =>
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
      container.resolve(KEYS.TRADES_REPO)
    )
  );

  // Playoff service
  container.register(KEYS.PLAYOFF_SERVICE, () =>
    new PlayoffService(
      container.resolve(KEYS.POOL),
      container.resolve(KEYS.PLAYOFF_REPO),
      container.resolve(KEYS.MATCHUPS_REPO),
      container.resolve(KEYS.LEAGUE_REPO),
      container.resolve(KEYS.ROSTER_REPO)
    )
  );

  // Invitations
  container.register(KEYS.INVITATIONS_REPO, () =>
    new InvitationsRepository(container.resolve(KEYS.POOL))
  );

  container.register(KEYS.INVITATIONS_SERVICE, () =>
    new InvitationsService(
      container.resolve(KEYS.INVITATIONS_REPO),
      container.resolve(KEYS.LEAGUE_REPO),
      container.resolve(KEYS.ROSTER_REPO),
      container.resolve(KEYS.USER_REPO),
      container.resolve(KEYS.ROSTER_SERVICE)
    )
  );

  // Helpers
  container.register(KEYS.LOCK_HELPER, () => new LockHelper());
}

// Auto-run bootstrap when this module is imported
bootstrap();
