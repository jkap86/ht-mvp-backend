import { container, KEYS } from './container';
import { pool } from './db/pool';

// Repositories
import { UserRepository } from './modules/auth/auth.repository';
import { LeagueRepository, RosterRepository } from './modules/leagues/leagues.repository';
import { DraftRepository } from './modules/drafts/drafts.repository';
import { ChatRepository } from './modules/chat/chat.repository';
import { PlayerRepository } from './modules/players/players.repository';

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
}

// Auto-run bootstrap when this module is imported
bootstrap();
