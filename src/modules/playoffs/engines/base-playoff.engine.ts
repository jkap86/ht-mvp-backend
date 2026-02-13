import { v4 as uuidv4 } from 'uuid';
import {
  IPlayoffEngine,
  AdvanceResult,
  SeriesWinner,
  SeriesLoser,
  PlayoffEngineContext,
} from './playoff-engine.interface';
import {
  BracketType,
  SeriesAggregation,
  getWeekRangeForRound,
  calculateTotalRounds,
} from '../playoff.model';
import { PlayoffRepository } from '../playoff.repository';
import { logger } from '../../../config/logger.config';
import {
  resolveSeriesWinner as domainResolveSeriesWinner,
  resolveSeriesLoser as domainResolveSeriesLoser,
} from '../../../domain/playoff/bracket';

/**
 * Base Playoff Engine
 *
 * Provides shared logic for all bracket types:
 * - Series winner/loser determination
 * - Standard bracket advancement
 * - 6-team bye handling
 *
 * Subclasses override specific behavior for their bracket type.
 */
export abstract class BasePlayoffEngine implements IPlayoffEngine {
  abstract readonly bracketType: BracketType;

  constructor(protected readonly playoffRepo: PlayoffRepository) {}

  /**
   * Template method for advancing from a week.
   * Subclasses implement `advanceInternal` for bracket-specific logic.
   */
  async advanceFromWeek(ctx: PlayoffEngineContext, week: number): Promise<AdvanceResult> {
    // Get completed series for this week and bracket type
    const completedSeries = await this.playoffRepo.getFinalizedSeriesEndingInWeek(
      ctx.leagueId,
      ctx.season,
      week,
      this.bracketType
    );

    if (completedSeries.length === 0) {
      return {
        advanced: false,
        seriesCompleted: 0,
        bracketComplete: false,
        message: `No completed ${this.bracketType} series to advance in week ${week}`,
      };
    }

    // Delegate to subclass for bracket-specific advancement
    return this.advanceInternal(ctx, week, completedSeries);
  }

  /**
   * Bracket-specific advancement logic.
   * Implemented by each subclass.
   */
  protected abstract advanceInternal(
    ctx: PlayoffEngineContext,
    week: number,
    completedSeries: SeriesAggregation[]
  ): Promise<AdvanceResult>;

  /**
   * Determine winner of a series using aggregate scoring.
   * Tie-breaker: lower seed number (higher seed) wins.
   */
  determineSeriesWinner(series: SeriesAggregation): number {
    return domainResolveSeriesWinner(series);
  }

  /**
   * Determine loser of a series — delegates to domain/playoff/bracket.
   */
  protected determineSeriesLoser(series: SeriesAggregation): number {
    return domainResolveSeriesLoser(series);
  }

  /**
   * Get winners from a list of completed series.
   */
  async getSeriesWinners(series: SeriesAggregation[]): Promise<SeriesWinner[]> {
    const winners: SeriesWinner[] = [];

    for (const s of series) {
      const winnerId = this.determineSeriesWinner(s);
      const winnerSeed = winnerId === s.roster1Id ? s.roster1Seed : s.roster2Seed;
      const winnerPoints = winnerId === s.roster1Id
        ? s.roster1TotalPoints
        : s.roster2TotalPoints;

      // Get bracket position from first game of series
      const seriesMatchups = await this.playoffRepo.getSeriesMatchups(s.seriesId);
      const bracketPosition = seriesMatchups[0]?.bracket_position ?? 0;

      winners.push({
        rosterId: winnerId,
        seed: winnerSeed,
        bracketPosition,
        aggregatePoints: winnerPoints,
      });
    }

    return winners;
  }

  /**
   * Get losers from a list of completed series.
   */
  async getSeriesLosers(series: SeriesAggregation[]): Promise<SeriesLoser[]> {
    const losers: SeriesLoser[] = [];

    for (const s of series) {
      const loserId = this.determineSeriesLoser(s);
      const loserSeed = loserId === s.roster1Id ? s.roster1Seed : s.roster2Seed;
      const loserPoints = loserId === s.roster1Id
        ? s.roster1TotalPoints
        : s.roster2TotalPoints;

      const seriesMatchups = await this.playoffRepo.getSeriesMatchups(s.seriesId);
      const bracketPosition = seriesMatchups[0]?.bracket_position ?? 0;

      losers.push({
        rosterId: loserId,
        seed: loserSeed,
        bracketPosition,
        aggregatePoints: loserPoints,
      });
    }

    return losers;
  }

  /**
   * Create next round matchups from winners.
   * Handles standard bracket progression and 6-team bye scenarios.
   */
  protected async createNextRoundMatchups(
    ctx: PlayoffEngineContext,
    winners: SeriesWinner[],
    nextRound: number,
    nextRoundWeekStart: number,
    nextRoundWeeks: number,
    teamCount: number
  ): Promise<void> {
    const { client, leagueId, season, bracket } = ctx;

    // Handle 6-team format with byes
    if (teamCount === 6 && nextRound === 2) {
      await this.createSixTeamByeRoundMatchups(
        ctx,
        winners,
        nextRound,
        nextRoundWeekStart,
        nextRoundWeeks
      );
      return;
    }

    // Standard bracket advancement
    winners.sort((a, b) => a.bracketPosition - b.bracketPosition);

    for (let i = 0; i < winners.length; i += 2) {
      if (i + 1 < winners.length) {
        const team1 = winners[i];
        const team2 = winners[i + 1];

        const seriesId = nextRoundWeeks > 1 ? uuidv4() : null;

        for (let game = 1; game <= nextRoundWeeks; game++) {
          const gameWeek = nextRoundWeekStart + game - 1;
          await this.playoffRepo.createPlayoffMatchupWithSeries(
            leagueId,
            season,
            gameWeek,
            team1.rosterId,
            team2.rosterId,
            nextRound,
            team1.seed,
            team2.seed,
            Math.floor(i / 2) + 1,
            this.bracketType,
            seriesId,
            game,
            nextRoundWeeks,
            client
          );
        }
      }
    }
  }

  /**
   * Create round 2 matchups for 6-team brackets with bye teams.
   */
  protected async createSixTeamByeRoundMatchups(
    ctx: PlayoffEngineContext,
    winners: SeriesWinner[],
    nextRound: number,
    nextRoundWeekStart: number,
    nextRoundWeeks: number
  ): Promise<void> {
    const { client, leagueId, season, bracket } = ctx;

    // Get bye teams from seeds
    const seedsType = this.bracketType === 'CONSOLATION' ? 'CONSOLATION' : 'WINNERS';
    const seeds = await this.playoffRepo.getSeedsByType(bracket.id, seedsType);
    const byeTeams = seeds.filter((s) => s.hasBye);

    winners.sort((a, b) => a.bracketPosition - b.bracketPosition);

    // Round 1 has: position 1 = 3v6, position 2 = 4v5
    // Round 2 needs:
    //   Semifinal 1: #1 seed vs winner of 4v5 (position 2)
    //   Semifinal 2: #2 seed vs winner of 3v6 (position 1)
    const winner4v5 = winners.find((w) => w.bracketPosition === 2);
    const winner3v6 = winners.find((w) => w.bracketPosition === 1);

    if (byeTeams.length >= 2 && winner4v5 && winner3v6) {
      const seed1 = byeTeams.find((s) => s.seed === 1);
      const seed2 = byeTeams.find((s) => s.seed === 2);

      if (seed1 && seed2) {
        // Semifinal 1: #1 vs winner of 4v5
        const series1Id = nextRoundWeeks > 1 ? uuidv4() : null;
        for (let game = 1; game <= nextRoundWeeks; game++) {
          const gameWeek = nextRoundWeekStart + game - 1;
          await this.playoffRepo.createPlayoffMatchupWithSeries(
            leagueId,
            season,
            gameWeek,
            seed1.rosterId,
            winner4v5.rosterId,
            nextRound,
            1,
            winner4v5.seed,
            1,
            this.bracketType,
            series1Id,
            game,
            nextRoundWeeks,
            client
          );
        }

        // Semifinal 2: #2 vs winner of 3v6
        const series2Id = nextRoundWeeks > 1 ? uuidv4() : null;
        for (let game = 1; game <= nextRoundWeeks; game++) {
          const gameWeek = nextRoundWeekStart + game - 1;
          await this.playoffRepo.createPlayoffMatchupWithSeries(
            leagueId,
            season,
            gameWeek,
            seed2.rosterId,
            winner3v6.rosterId,
            nextRound,
            2,
            winner3v6.seed,
            2,
            this.bracketType,
            series2Id,
            game,
            nextRoundWeeks,
            client
          );
        }

        logger.info(
          `Created 6-team ${this.bracketType} round ${nextRound} with bye teams for league ${leagueId}`
        );
        return;
      }
    }

    // Fallback to standard advancement if bye handling fails
    logger.warn(
      `6-team ${this.bracketType} bye handling failed, falling back to standard advancement`
    );
    await this.createNextRoundMatchups(
      ctx,
      winners,
      nextRound,
      nextRoundWeekStart,
      nextRoundWeeks,
      8 // Force standard 8-team advancement as fallback
    );
  }

  /**
   * Calculate next round parameters from the current round.
   */
  protected getNextRoundParams(
    bracket: { startWeek: number; weeksByRound: number[] | null },
    currentRound: number
  ): { nextRound: number; weekStart: number; weeks: number } {
    const nextRound = currentRound + 1;
    const { weekStart } = getWeekRangeForRound(
      bracket.startWeek,
      bracket.weeksByRound,
      nextRound
    );
    const weeks = bracket.weeksByRound?.[nextRound - 1] ?? 1;

    return { nextRound, weekStart, weeks };
  }

  /**
   * Check if all series for a round are complete.
   */
  protected async areAllSeriesComplete(
    leagueId: number,
    season: number,
    round: number
  ): Promise<boolean> {
    return this.playoffRepo.areAllSeriesCompleteForRound(
      leagueId,
      season,
      round,
      this.bracketType
    );
  }

  /**
   * Check if next round matchups already exist.
   */
  protected async nextRoundExists(
    leagueId: number,
    season: number,
    round: number
  ): Promise<boolean> {
    return this.playoffRepo.roundMatchupsExistForType(
      leagueId,
      season,
      round,
      this.bracketType
    );
  }
}
