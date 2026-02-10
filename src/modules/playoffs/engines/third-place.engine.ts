import { BasePlayoffEngine } from './base-playoff.engine';
import { AdvanceResult, PlayoffEngineContext } from './playoff-engine.interface';
import { BracketType, SeriesAggregation } from '../playoff.model';
import { PlayoffRepository } from '../playoff.repository';
import { logger } from '../../../config/logger.config';

/**
 * Third Place Engine
 *
 * Handles the THIRD_PLACE bracket - the 3rd place game between semifinal losers.
 * Created automatically when semifinals complete (if enabled).
 *
 * Flow:
 * 1. Wait for 3rd place game/series to complete
 * 2. Set 3rd place winner on bracket
 * 3. Finalize bracket if all results are in
 */
export class ThirdPlaceEngine extends BasePlayoffEngine {
  readonly bracketType: BracketType = 'THIRD_PLACE';

  constructor(playoffRepo: PlayoffRepository) {
    super(playoffRepo);
  }

  protected async advanceInternal(
    ctx: PlayoffEngineContext,
    week: number,
    completedSeries: SeriesAggregation[]
  ): Promise<AdvanceResult> {
    const { client, leagueId, bracket } = ctx;

    if (completedSeries.length === 0) {
      return {
        advanced: false,
        seriesCompleted: 0,
        bracketComplete: false,
        message: 'No completed THIRD_PLACE series to advance',
      };
    }

    // Should only be one 3rd place series
    const thirdPlaceSeries = completedSeries[0];
    const winnerId = this.determineSeriesWinner(thirdPlaceSeries);

    await this.playoffRepo.setThirdPlaceWinner(bracket.id, winnerId, client);
    await this.playoffRepo.finalizeBracketIfComplete(bracket.id, client);

    logger.info(
      `League ${leagueId} 3rd place won by roster ${winnerId} ` +
      `with aggregate ${thirdPlaceSeries.roster1TotalPoints}-${thirdPlaceSeries.roster2TotalPoints}`
    );

    return {
      advanced: true,
      seriesCompleted: 1,
      bracketComplete: false, // May still have consolation running
      winnerId,
      message: `3rd place winner: roster ${winnerId}`,
    };
  }
}
