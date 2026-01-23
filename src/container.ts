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
  PLAYER_REPO: 'playerRepo',

  // Services
  AUTH_SERVICE: 'authService',
  LEAGUE_SERVICE: 'leagueService',
  ROSTER_SERVICE: 'rosterService',
  DRAFT_SERVICE: 'draftService',
  DRAFT_ORDER_SERVICE: 'draftOrderService',
  DRAFT_PICK_SERVICE: 'draftPickService',
  DRAFT_STATE_SERVICE: 'draftStateService',
  DRAFT_AUTOPICK_SERVICE: 'draftAutopickService',
  DRAFT_QUEUE_SERVICE: 'draftQueueService',
  CHAT_SERVICE: 'chatService',
  PLAYER_SERVICE: 'playerService',
  SOCKET_SERVICE: 'socketService',

  // Engines
  DRAFT_ENGINE_FACTORY: 'draftEngineFactory',

  // External Clients
  SLEEPER_CLIENT: 'sleeperClient',
};
