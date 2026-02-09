import { IPlayoffEngine } from './playoff-engine.interface';
import { BracketType } from '../playoff.model';
import { PlayoffRepository } from '../playoff.repository';
import { SingleEliminationEngine } from './single-elimination.engine';
import { ThirdPlaceEngine } from './third-place.engine';
import { ConsolationEngine } from './consolation.engine';

/**
 * Factory for creating playoff engines based on bracket type.
 *
 * Usage:
 *   const factory = new PlayoffEngineFactory(playoffRepo);
 *   const engine = factory.create('WINNERS');
 *   await engine.advanceFromWeek(ctx, week);
 */
export class PlayoffEngineFactory {
  constructor(private readonly playoffRepo: PlayoffRepository) {}

  /**
   * Create an engine for the specified bracket type.
   *
   * @param bracketType - The type of bracket to process
   * @returns The appropriate engine implementation
   * @throws Error if bracket type is unknown
   */
  create(bracketType: BracketType): IPlayoffEngine {
    switch (bracketType) {
      case 'WINNERS':
        return new SingleEliminationEngine(this.playoffRepo);
      case 'THIRD_PLACE':
        return new ThirdPlaceEngine(this.playoffRepo);
      case 'CONSOLATION':
        return new ConsolationEngine(this.playoffRepo);
      default:
        throw new Error(`Unknown bracket type: ${bracketType}`);
    }
  }

  /**
   * Create all engines for a complete playoff bracket.
   * Useful when processing all bracket types in a single week.
   *
   * @returns Map of bracket type to engine
   */
  createAll(): Map<BracketType, IPlayoffEngine> {
    const engines = new Map<BracketType, IPlayoffEngine>();
    engines.set('WINNERS', this.create('WINNERS'));
    engines.set('THIRD_PLACE', this.create('THIRD_PLACE'));
    engines.set('CONSOLATION', this.create('CONSOLATION'));
    return engines;
  }
}
