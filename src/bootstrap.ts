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

// Services
import { AuthService } from './modules/auth/auth.service';
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
import { MatchupService } from './modules/matchups/matchups.service';

// Engines
import { DraftEngineFactory } from './engines';

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

  // External Clients
  container.register(KEYS.SLEEPER_CLIENT, () => new SleeperApiClient());

  // Services
  container.register(KEYS.AUTH_SERVICE, () =>
    new AuthService(container.resolve(KEYS.USER_REPO))
  );

  container.register(KEYS.ROSTER_SERVICE, () =>
    new RosterService(
      container.resolve(KEYS.LEAGUE_REPO),
      container.resolve(KEYS.ROSTER_REPO),
      container.resolve(KEYS.USER_REPO)
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
      container.resolve(KEYS.DRAFT_REPO),
      container.resolve(KEYS.LEAGUE_REPO),
      container.resolve(KEYS.ROSTER_REPO)
    )
  );

  // Engines (needed by DraftPickService)
  container.register(KEYS.DRAFT_ENGINE_FACTORY, () =>
    new DraftEngineFactory(
      container.resolve(KEYS.DRAFT_REPO),
      container.resolve(KEYS.PLAYER_REPO)
    )
  );

  container.register(KEYS.DRAFT_PICK_SERVICE, () =>
    new DraftPickService(
      container.resolve(KEYS.DRAFT_REPO),
      container.resolve(KEYS.LEAGUE_REPO),
      container.resolve(KEYS.ROSTER_REPO),
      container.resolve(KEYS.DRAFT_ENGINE_FACTORY),
      container.resolve(KEYS.PLAYER_REPO)
    )
  );

  container.register(KEYS.DRAFT_STATE_SERVICE, () =>
    new DraftStateService(
      container.resolve(KEYS.DRAFT_REPO),
      container.resolve(KEYS.LEAGUE_REPO),
      container.resolve(KEYS.DRAFT_ENGINE_FACTORY)
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
      container.resolve(KEYS.SLOW_AUCTION_SERVICE),
      container.resolve(KEYS.PLAYER_REPO)
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

  // Season management services
  container.register(KEYS.ROSTER_PLAYER_SERVICE, () =>
    new RosterPlayerService(
      container.resolve(KEYS.POOL),
      container.resolve(KEYS.ROSTER_PLAYERS_REPO),
      container.resolve(KEYS.ROSTER_TRANSACTIONS_REPO),
      container.resolve(KEYS.ROSTER_REPO),
      container.resolve(KEYS.LEAGUE_REPO)
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

  container.register(KEYS.MATCHUP_SERVICE, () =>
    new MatchupService(
      container.resolve(KEYS.POOL),
      container.resolve(KEYS.MATCHUPS_REPO),
      container.resolve(KEYS.LINEUPS_REPO),
      container.resolve(KEYS.ROSTER_REPO),
      container.resolve(KEYS.LEAGUE_REPO),
      container.resolve(KEYS.SCORING_SERVICE)
    )
  );
}

// Auto-run bootstrap when this module is imported
bootstrap();
