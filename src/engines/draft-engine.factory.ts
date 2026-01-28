import { IDraftEngine } from './draft-engine.interface';
import { SnakeDraftEngine } from './snake-draft.engine';
import { LinearDraftEngine } from './linear-draft.engine';
import { DraftRepository } from '../modules/drafts/drafts.repository';
import { PlayerRepository } from '../modules/players/players.repository';
import { RosterPlayersRepository } from '../modules/rosters/rosters.repository';
import { LeagueRepository } from '../modules/leagues/leagues.repository';

/**
 * Factory for creating draft engines based on draft type.
 * Uses Strategy pattern to provide the correct engine for each draft type.
 *
 * NOTE: Auction drafts do NOT use this factory. They use ActionDispatcher +
 * AuctionActionHandler + FastAuctionService/SlowAuctionService instead.
 * Callers should check `draftType !== 'auction'` before using createEngine().
 */
export class DraftEngineFactory {
  constructor(
    private readonly draftRepo: DraftRepository,
    private readonly playerRepo: PlayerRepository,
    private readonly rosterPlayersRepo: RosterPlayersRepository,
    private readonly leagueRepo: LeagueRepository
  ) {}

  /**
   * Create an engine for the specified draft type
   */
  createEngine(draftType: string): IDraftEngine {
    switch (draftType.toLowerCase()) {
      case 'snake':
        return new SnakeDraftEngine(
          this.draftRepo,
          this.playerRepo,
          this.rosterPlayersRepo,
          this.leagueRepo
        );
      case 'linear':
        return new LinearDraftEngine(
          this.draftRepo,
          this.playerRepo,
          this.rosterPlayersRepo,
          this.leagueRepo
        );
      default:
        throw new Error(`Unknown draft type: ${draftType}`);
    }
  }

  /**
   * Get engine for a specific draft by ID
   */
  async getEngineForDraft(draftId: number): Promise<IDraftEngine> {
    const draft = await this.draftRepo.findById(draftId);
    if (!draft) {
      throw new Error(`Draft not found: ${draftId}`);
    }
    return this.createEngine(draft.draftType);
  }
}
