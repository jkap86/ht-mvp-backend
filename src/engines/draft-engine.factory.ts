import { IDraftEngine } from './draft-engine.interface';
import { SnakeDraftEngine } from './snake-draft.engine';
import { LinearDraftEngine } from './linear-draft.engine';
import { DraftRepository } from '../modules/drafts/drafts.repository';
import { PlayerRepository } from '../modules/players/players.repository';

/**
 * Factory for creating draft engines based on draft type.
 * Uses Strategy pattern to provide the correct engine for each draft type.
 */
export class DraftEngineFactory {
  constructor(
    private readonly draftRepo: DraftRepository,
    private readonly playerRepo: PlayerRepository
  ) {}

  /**
   * Create an engine for the specified draft type
   */
  createEngine(draftType: string): IDraftEngine {
    switch (draftType.toLowerCase()) {
      case 'snake':
        return new SnakeDraftEngine(this.draftRepo, this.playerRepo);
      case 'linear':
        return new LinearDraftEngine(this.draftRepo, this.playerRepo);
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
