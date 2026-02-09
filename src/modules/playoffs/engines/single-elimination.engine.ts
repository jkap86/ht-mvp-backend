import { v4 as uuidv4 } from 'uuid';
import { BasePlayoffEngine } from './base-playoff.engine';
import { AdvanceResult, PlayoffEngineContext } from './playoff-engine.interface';
import { BracketType, SeriesAggregation, getWeekRangeForRound } from '../playoff.model';
import { PlayoffRepository } from '../playoff.repository';
import { EventTypes, tryGetEventBus } from '../../../shared/events';
import { logger } from '../../../config/env.config';

/**
 * Single Elimination Engine
 *
 * Handles the WINNERS bracket - the main playoff bracket.
 * Supports 4, 6, and 8 team formats with multi-week series.
 *
 * Flow:
 * 1. Advance winners from completed series to next round
 * 2. Create 3rd place game when semifinals complete (if enabled)
 * 3. Crown champion when championship series completes
 */
export class SingleEliminationEngine extends BasePlayoffEngine {
  readonly bracketType: BracketType = 'WINNERS';

  constructor(playoffRepo: PlayoffRepository) {
    super(playoffRepo);
  }

  protected async advanceInternal(
    ctx: PlayoffEngineContext,
    week: number,
    completedSeries: SeriesAggregation[]
  ): Promise<AdvanceResult> {
    const { client, leagueId, season, bracket } = ctx;

    // Determine current round from completed series
    if (completedSeries.length === 0) {
      return {
        advanced: false,
        seriesCompleted: 0,
        bracketComplete: false,
        message: 'No completed WINNERS series to advance',
      };
    }

    // Get the round from the first series (all should be same round)
    const firstSeriesMatchups = await this.playoffRepo.getSeriesMatchups(
      completedSeries[0].seriesId
    );
    const currentRound = firstSeriesMatchups[0]?.playoff_round ?? 1;

    const isChampionship = currentRound === bracket.totalRounds;
    const isSemifinals = currentRound === bracket.totalRounds - 1;

    // Handle championship
    if (isChampionship) {
      const championshipSeries = completedSeries[0];
      const winnerId = this.determineSeriesWinner(championshipSeries);

      await this.playoffRepo.setChampion(bracket.id, winnerId, client);
      await this.playoffRepo.finalizeBracketIfComplete(bracket.id, client);

      // Emit champion crowned event
      this.emitChampionCrowned(leagueId, bracket.id, winnerId);

      logger.info(
        `League ${leagueId} championship won by roster ${winnerId} ` +
        `with aggregate ${championshipSeries.roster1TotalPoints}-${championshipSeries.roster2TotalPoints}`
      );

      return {
        advanced: true,
        seriesCompleted: 1,
        bracketComplete: true,
        winnerId,
        message: `Champion crowned: roster ${winnerId}`,
      };
    }

    // Check if all series for this round are complete
    const allComplete = await this.areAllSeriesComplete(leagueId, season, currentRound);
    if (!allComplete) {
      logger.info(
        `League ${leagueId} round ${currentRound}: Not all WINNERS series complete yet`
      );
      return {
        advanced: false,
        seriesCompleted: completedSeries.length,
        bracketComplete: false,
        message: `Round ${currentRound} series not all complete`,
      };
    }

    // Get next round parameters
    const { nextRound, weekStart, weeks } = this.getNextRoundParams(bracket, currentRound);

    // Create 3rd place game if enabled and we just finished semifinals
    if (isSemifinals && bracket.enableThirdPlace) {
      await this.createThirdPlaceGame(ctx, completedSeries, weekStart, weeks);
    }

    // Check if next round already exists
    const nextExists = await this.nextRoundExists(leagueId, season, nextRound);
    if (nextExists) {
      return {
        advanced: false,
        seriesCompleted: completedSeries.length,
        bracketComplete: false,
        message: `Round ${nextRound} matchups already exist`,
      };
    }

    // Get winners and create next round
    const winners = await this.getSeriesWinners(completedSeries);
    await this.createNextRoundMatchups(
      ctx,
      winners,
      nextRound,
      weekStart,
      weeks,
      bracket.playoffTeams
    );

    logger.info(
      `League ${leagueId}: Advanced ${winners.length} winners to round ${nextRound}`
    );

    return {
      advanced: true,
      seriesCompleted: completedSeries.length,
      bracketComplete: false,
      message: `Advanced ${winners.length} winners to round ${nextRound}`,
    };
  }

  /**
   * Create 3rd place game from semifinal losers.
   */
  private async createThirdPlaceGame(
    ctx: PlayoffEngineContext,
    semifinalSeries: SeriesAggregation[],
    championshipWeekStart: number,
    championshipWeeks: number
  ): Promise<void> {
    const { client, leagueId, season, bracket } = ctx;

    // Check if already exists
    const exists = await this.playoffRepo.roundMatchupsExistForType(
      leagueId,
      season,
      bracket.totalRounds,
      'THIRD_PLACE'
    );
    if (exists) return; // Idempotent

    // Get losers from semifinal series
    const losers = await this.getSeriesLosers(semifinalSeries);

    if (losers.length !== 2) {
      logger.warn(`Expected 2 semifinal losers, got ${losers.length}`);
      return;
    }

    // Sort by seed (lower seed gets position 1)
    losers.sort((a, b) => a.seed - b.seed);

    // Create 3rd place series
    const seriesId = championshipWeeks > 1 ? uuidv4() : null;

    for (let game = 1; game <= championshipWeeks; game++) {
      const gameWeek = championshipWeekStart + game - 1;
      await this.playoffRepo.createPlayoffMatchupWithSeries(
        leagueId,
        season,
        gameWeek,
        losers[0].rosterId,
        losers[1].rosterId,
        bracket.totalRounds, // Same round as championship
        losers[0].seed,
        losers[1].seed,
        2, // bracket_position = 2 (championship is position 1)
        'THIRD_PLACE',
        seriesId,
        game,
        championshipWeeks,
        client
      );
    }

    logger.info(`Created 3rd place series for league ${leagueId}`);
  }

  /**
   * Emit champion crowned event
   */
  private emitChampionCrowned(
    leagueId: number,
    bracketId: number,
    championRosterId: number
  ): void {
    const eventBus = tryGetEventBus();
    eventBus?.publish({
      type: EventTypes.PLAYOFF_CHAMPION_CROWNED,
      leagueId,
      payload: { bracketId, championRosterId },
    });
  }
}
