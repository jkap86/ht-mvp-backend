/**
 * Playoff Engines Module
 *
 * Provides pure bracket logic for different playoff bracket types.
 * Engines compute decisions only - state writes are delegated back to services.
 *
 * Available engines:
 * - SingleEliminationEngine: WINNERS bracket (main playoff bracket)
 * - ThirdPlaceEngine: THIRD_PLACE bracket (3rd place game)
 * - ConsolationEngine: CONSOLATION bracket (for non-playoff teams)
 */

export { IPlayoffEngine, PlayoffEngineContext, AdvanceResult, SeriesWinner, SeriesLoser } from './playoff-engine.interface';
export { BasePlayoffEngine } from './base-playoff.engine';
export { SingleEliminationEngine } from './single-elimination.engine';
export { ThirdPlaceEngine } from './third-place.engine';
export { ConsolationEngine } from './consolation.engine';
export { PlayoffEngineFactory } from './playoff-engine.factory';
