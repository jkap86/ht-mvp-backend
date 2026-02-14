import { v4 as uuidv4 } from 'uuid';
import { BasePlayoffEngine } from './base-playoff.engine';
import { AdvanceResult, PlayoffEngineContext, SeriesWinner } from './playoff-engine.interface';
import { BracketType, SeriesAggregation, calculateTotalRounds, getWeekRangeForRound } from '../../modules/playoffs/playoff.model';
import { PlayoffRepository } from '../../modules/playoffs/playoff.repository';
import { logger } from '../../config/logger.config';

/**
 * Consolation Engine
 *
 * Handles the CONSOLATION bracket - for teams that didn't make playoffs.
 * Supports 4, 6, and 8 team formats with multi-week series.
 *
 * Flow:
 * 1. Advance winners from completed series to next round
 * 2. Handle 6-team byes in round 2
 * 3. Crown consolation winner when final round completes
 */
export class ConsolationEngine extends BasePlayoffEngine {
  readonly bracketType: BracketType = 'CONSOLATION';

  constructor(playoffRepo: PlayoffRepository) {
    super(playoffRepo);
  }

  protected async advanceInternal(
    ctx: PlayoffEngineContext,
    week: number,
    completedSeries: SeriesAggregation[]
  ): Promise<AdvanceResult> {
    const { client, leagueId, season, bracket } = ctx;

    if (completedSeries.length === 0) {
      return {
        advanced: false,
        seriesCompleted: 0,
        bracketComplete: false,
        message: 'No completed CONSOLATION series to advance',
      };
    }

    // Determine consolation total rounds based on consolation team count
    const consolationTotalRounds = calculateTotalRounds(bracket.consolationTeams!);

    // Get the round from the first series
    const firstSeriesMatchups = await this.playoffRepo.getSeriesMatchups(
      completedSeries[0].seriesId
    );
    const currentRound = firstSeriesMatchups[0]?.playoff_round ?? 1;
    const isFinal = currentRound === consolationTotalRounds;

    // Handle consolation final
    if (isFinal) {
      const finalSeries = completedSeries[0];
      const winnerId = this.determineSeriesWinner(finalSeries);

      await this.playoffRepo.setConsolationWinner(bracket.id, winnerId, client);
      await this.playoffRepo.finalizeBracketIfComplete(bracket.id, client);

      logger.info(
        `League ${leagueId} consolation won by roster ${winnerId} ` +
        `with aggregate ${finalSeries.roster1TotalPoints}-${finalSeries.roster2TotalPoints}`
      );

      return {
        advanced: true,
        seriesCompleted: 1,
        bracketComplete: false, // Overall bracket may still have winners running
        winnerId,
        message: `Consolation winner: roster ${winnerId}`,
      };
    }

    // Check if all series for this round are complete
    const allComplete = await this.areAllSeriesComplete(leagueId, season, currentRound);
    if (!allComplete) {
      logger.info(
        `League ${leagueId} round ${currentRound}: Not all CONSOLATION series complete yet`
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

    // Get winners
    const winners = await this.getSeriesWinners(completedSeries);

    // Handle 6-team bye scenario in round 2
    if (bracket.consolationTeams === 6 && nextRound === 2) {
      await this.createRound2WithByes(ctx, winners, weekStart, weeks);
    } else {
      await this.createNextRoundMatchups(
        ctx,
        winners,
        nextRound,
        weekStart,
        weeks,
        bracket.consolationTeams!
      );
    }

    logger.info(
      `League ${leagueId}: Advanced ${winners.length} winners to consolation round ${nextRound}`
    );

    return {
      advanced: true,
      seriesCompleted: completedSeries.length,
      bracketComplete: false,
      message: `Advanced ${winners.length} winners to consolation round ${nextRound}`,
    };
  }

  /**
   * Create round 2 matchups with bye teams for 6-team format.
   * In 6-team consolation:
   * - Seeds 1-2 have byes
   * - Round 1: 3v6, 4v5
   * - Round 2: #1 vs winner of 4v5, #2 vs winner of 3v6
   */
  private async createRound2WithByes(
    ctx: PlayoffEngineContext,
    winners: SeriesWinner[],
    weekStart: number,
    weeks: number
  ): Promise<void> {
    const { client, leagueId, season, bracket } = ctx;

    // Get bye teams from persisted consolation seeds
    const consolationSeeds = await this.playoffRepo.getSeedsByType(bracket.id, 'CONSOLATION');
    const byeTeams = consolationSeeds.filter((s) => s.hasBye);

    if (byeTeams.length < 2) {
      logger.warn(`Expected 2 bye teams for 6-team consolation, got ${byeTeams.length}`);
      // Fall back to standard advancement
      await this.createNextRoundMatchups(ctx, winners, 2, weekStart, weeks, 6);
      return;
    }

    // Sort winners by bracket position
    winners.sort((a, b) => a.bracketPosition - b.bracketPosition);

    // Round 1 positions: 1 = 3v6, 2 = 4v5
    const winner3v6 = winners.find((w) => w.bracketPosition === 1);
    const winner4v5 = winners.find((w) => w.bracketPosition === 2);

    if (!winner3v6 || !winner4v5) {
      logger.warn('Missing winners for 6-team consolation round 2');
      return;
    }

    const seed1 = byeTeams.find((s) => s.seed === 1);
    const seed2 = byeTeams.find((s) => s.seed === 2);

    if (!seed1 || !seed2) {
      logger.warn('Missing bye seeds for 6-team consolation round 2');
      return;
    }

    // Semifinal 1: #1 seed vs winner of 4v5
    const series1Id = weeks > 1 ? uuidv4() : null;
    for (let game = 1; game <= weeks; game++) {
      const gameWeek = weekStart + game - 1;
      await this.playoffRepo.createPlayoffMatchupWithSeries(
        leagueId,
        season,
        gameWeek,
        seed1.rosterId,
        winner4v5.rosterId,
        2, // round
        1, // seed1
        winner4v5.seed,
        1, // bracket position
        'CONSOLATION',
        series1Id,
        game,
        weeks,
        client
      );
    }

    // Semifinal 2: #2 seed vs winner of 3v6
    const series2Id = weeks > 1 ? uuidv4() : null;
    for (let game = 1; game <= weeks; game++) {
      const gameWeek = weekStart + game - 1;
      await this.playoffRepo.createPlayoffMatchupWithSeries(
        leagueId,
        season,
        gameWeek,
        seed2.rosterId,
        winner3v6.rosterId,
        2, // round
        2, // seed1
        winner3v6.seed,
        2, // bracket position
        'CONSOLATION',
        series2Id,
        game,
        weeks,
        client
      );
    }

    logger.info(`Created 6-team consolation round 2 with bye teams for league ${leagueId}`);
  }
}
