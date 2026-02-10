import { Pool, PoolClient } from 'pg';
import { PlayoffRepository } from './playoff.repository';
import { MatchupsRepository } from '../matchups/matchups.repository';
import { LeagueRepository } from '../leagues/leagues.repository';
import {
  PlayoffBracketView,
  PlayoffMatchup,
  PlayoffRound,
  PlayoffTeamInfo,
  PlayoffBracket,
  PlayoffSettings,
  ConsolationSeed,
  BracketType,
  ConsolationType,
  SeriesAggregation,
  calculateTotalRounds,
  calculateTotalPlayoffWeeks,
  getRoundName,
  getConsolationRoundName,
  getWeekRangeForRound,
  getWeekForRoundGame,
  generateBracketConfig,
  generateConsolationBracketConfig,
} from './playoff.model';
import { v4 as uuidv4 } from 'uuid';
import {
  NotFoundException,
  ForbiddenException,
  ValidationException,
  ConflictException,
} from '../../utils/exceptions';
import { logger } from '../../config/logger.config';
import { runWithLock, LockDomain } from '../../shared/transaction-runner';
import { EventTypes, tryGetEventBus } from '../../shared/events';

export class PlayoffService {
  constructor(
    private readonly db: Pool,
    private readonly playoffRepo: PlayoffRepository,
    private readonly matchupsRepo: MatchupsRepository,
    private readonly leagueRepo: LeagueRepository
  ) {}

  /**
   * Generate playoff bracket and initial matchups
   * Commissioner-only action
   */
  async generatePlayoffBracket(
    leagueId: number,
    userId: string,
    config: {
      playoffTeams: number;
      startWeek: number;
      weeksByRound?: number[]; // [1, 2, 2] = R1:1wk, R2:2wk, R3:2wk
      enableThirdPlaceGame?: boolean;
      consolationType?: ConsolationType;
      consolationTeams?: number;
    },
    idempotencyKey?: string
  ): Promise<PlayoffBracketView> {
    // Validate commissioner
    const isCommissioner = await this.leagueRepo.isCommissioner(leagueId, userId);
    if (!isCommissioner) {
      throw new ForbiddenException('Only the commissioner can generate playoff bracket');
    }

    // Validate playoff teams
    if (![4, 6, 8].includes(config.playoffTeams)) {
      throw new ValidationException('Playoff teams must be 4, 6, or 8');
    }

    // Get league
    const league = await this.leagueRepo.findById(leagueId);
    if (!league) {
      throw new NotFoundException('League not found');
    }

    const season = parseInt(league.season, 10);
    const currentWeek = league.currentWeek || 1;
    const totalRounds = calculateTotalRounds(config.playoffTeams);

    // Validate and process weeksByRound
    let weeksByRound = config.weeksByRound ?? null;
    if (weeksByRound) {
      // Validate length matches totalRounds
      if (weeksByRound.length !== totalRounds) {
        throw new ValidationException(
          `weeksByRound must have ${totalRounds} elements for ${config.playoffTeams}-team playoffs, got ${weeksByRound.length}`
        );
      }
      // Validate each value is 1 or 2
      for (let i = 0; i < weeksByRound.length; i++) {
        if (weeksByRound[i] !== 1 && weeksByRound[i] !== 2) {
          throw new ValidationException(
            `weeksByRound[${i}] must be 1 or 2, got ${weeksByRound[i]}`
          );
        }
      }
    }

    // Calculate total playoff weeks
    const totalPlayoffWeeks = calculateTotalPlayoffWeeks(weeksByRound, totalRounds);
    const lastPlayoffWeek = config.startWeek + totalPlayoffWeeks - 1;

    // Validate playoffs fit within season (max week 18)
    if (lastPlayoffWeek > 18) {
      throw new ValidationException(
        `Playoffs would end in week ${lastPlayoffWeek}, but season ends in week 18. ` +
        `Reduce playoff weeks or start earlier.`
      );
    }

    // Validate startWeek is not in the past
    if (config.startWeek < currentWeek) {
      throw new ValidationException(
        `Playoff start week (${config.startWeek}) cannot be before current week (${currentWeek})`
      );
    }

    // Check for existing bracket
    const existingBracket = await this.playoffRepo.findByLeagueSeason(leagueId, season);
    if (existingBracket) {
      // Idempotency: if bracket already exists, check if we have a cached result
      if (idempotencyKey) {
        const existing = await this.db.query(
          `SELECT result FROM playoff_operations
           WHERE idempotency_key = $1 AND user_id = $2 AND operation_type = 'generate'
           AND expires_at > NOW()`,
          [idempotencyKey, userId]
        );
        if (existing.rows.length > 0) {
          return existing.rows[0].result;
        }
      }

      // No cached result, throw error
      throw new ConflictException(
        'Cannot generate playoffs: bracket already exists for this season. ' +
        'Delete existing bracket before regenerating.'
      );
    }

    // Check for existing regular season matchups in playoff week range
    const conflictingMatchups = await this.matchupsRepo.findMatchupsInWeekRange(
      leagueId,
      season,
      config.startWeek,
      lastPlayoffWeek,
      false // is_playoff = false (regular season matchups)
    );
    if (conflictingMatchups.length > 0) {
      throw new ConflictException(
        `Cannot generate playoffs: regular season matchups already exist in weeks ${config.startWeek}–${lastPlayoffWeek}. ` +
        `Clear schedule or choose a different start week.`
      );
    }

    // Get standings for seeding
    const standings = await this.matchupsRepo.getStandings(leagueId, season);
    if (standings.length < config.playoffTeams) {
      throw new ValidationException(
        `Not enough teams for playoffs. Need ${config.playoffTeams}, have ${standings.length}`
      );
    }

    // Process new optional settings
    const enableThirdPlace = config.enableThirdPlaceGame ?? false;
    const consolationType = config.consolationType ?? 'NONE';
    let consolationTeams: number | null = null;

    // Validate consolation settings
    if (consolationType === 'CONSOLATION') {
      const nonPlayoffTeams = standings.length - config.playoffTeams;

      if (nonPlayoffTeams < 4) {
        throw new ValidationException(
          `Not enough teams for consolation bracket. Need at least 4 non-playoff teams, have ${nonPlayoffTeams}`
        );
      }

      // Default to all non-playoff teams, capped at 8
      consolationTeams = config.consolationTeams ?? Math.min(nonPlayoffTeams, 8);

      // Validate consolation team count
      if (![4, 6, 8].includes(consolationTeams)) {
        throw new ValidationException('Consolation teams must be 4, 6, or 8');
      }

      if (consolationTeams > nonPlayoffTeams) {
        throw new ValidationException(
          `Cannot have ${consolationTeams} consolation teams with only ${nonPlayoffTeams} non-playoff teams`
        );
      }
    }

    const bracketId = await runWithLock(this.db, LockDomain.LEAGUE, leagueId, async (client) => {
      // Calculate championship week using weeksByRound
      const championshipWeek = lastPlayoffWeek;

      // Create bracket with new settings including weeksByRound
      const bracket = await this.playoffRepo.createBracket(
        leagueId,
        season,
        config.playoffTeams,
        totalRounds,
        config.startWeek,
        championshipWeek,
        enableThirdPlace,
        consolationType,
        consolationTeams,
        weeksByRound,
        client
      );

      // Generate seeds from standings
      const topTeams = standings.slice(0, config.playoffTeams);
      const byeSeeds = config.playoffTeams === 6 ? [1, 2] : [];

      const seedData = topTeams.map((standing, index) => ({
        rosterId: standing.rosterId,
        seed: index + 1,
        regularSeasonRecord: `${standing.wins}-${standing.losses}${standing.ties > 0 ? `-${standing.ties}` : ''}`,
        pointsFor: standing.pointsFor,
        hasBye: byeSeeds.includes(index + 1),
      }));

      const seeds = await this.playoffRepo.createSeeds(bracket.id, seedData, client);

      // Generate round 1 matchups with series support
      const bracketConfig = generateBracketConfig(config.playoffTeams, config.startWeek);
      const seedMap = new Map(seeds.map((s) => [s.seed, s]));

      // Get weeks for round 1
      const round1Weeks = weeksByRound?.[0] ?? 1;

      for (const matchup of bracketConfig) {
        const seed1 = seedMap.get(matchup.seed1);
        const seed2 = matchup.seed2 ? seedMap.get(matchup.seed2) : null;

        if (!seed1) continue;
        if (!seed2) continue; // Skip bye matchups in round 1

        // Generate series_id for multi-week rounds
        const seriesId = round1Weeks > 1 ? uuidv4() : null;

        // Create matchup(s) for each game in the series
        for (let game = 1; game <= round1Weeks; game++) {
          const gameWeek = getWeekForRoundGame(config.startWeek, weeksByRound, 1, game);
          await this.playoffRepo.createPlayoffMatchupWithSeries(
            leagueId,
            season,
            gameWeek,
            seed1.rosterId,
            seed2.rosterId,
            matchup.round,
            matchup.seed1,
            matchup.seed2!,
            matchup.bracketPosition,
            'WINNERS',
            seriesId,
            game,
            round1Weeks,
            client
          );
        }
      }

      // Generate consolation bracket if enabled
      if (consolationType === 'CONSOLATION' && consolationTeams) {
        await this.generateConsolationBracket(
          client,
          leagueId,
          season,
          config.startWeek,
          consolationTeams,
          standings,
          config.playoffTeams,
          bracket.id,
          weeksByRound
        );
      }

      return bracket.id;
    });

    // Emit event AFTER transaction
    this.emitBracketGenerated(leagueId, bracketId);

    logger.info(`Generated ${config.playoffTeams}-team playoff bracket for league ${leagueId}`);

    // Return full bracket view
    const bracketView = await this.buildBracketView(bracketId);

    // Store result for idempotency
    if (idempotencyKey) {
      await this.db.query(
        `INSERT INTO playoff_operations (idempotency_key, bracket_id, league_id, user_id, operation_type, result)
         VALUES ($1, $2, $3, $4, 'generate', $5)
         ON CONFLICT (idempotency_key, user_id, operation_type) DO NOTHING`,
        [idempotencyKey, bracketId, leagueId, userId, JSON.stringify(bracketView)]
      );
    }

    return bracketView;
  }

  /**
   * Get playoff bracket view for a league
   */
  async getPlayoffBracket(leagueId: number, userId: string): Promise<PlayoffBracketView | null> {
    // Validate membership
    const isMember = await this.leagueRepo.isUserMember(leagueId, userId);
    if (!isMember) {
      throw new ForbiddenException('You are not a member of this league');
    }

    const league = await this.leagueRepo.findById(leagueId);
    if (!league) {
      throw new NotFoundException('League not found');
    }

    const season = parseInt(league.season, 10);
    const bracket = await this.playoffRepo.findByLeagueSeason(leagueId, season);
    if (!bracket) {
      return null;
    }

    return this.buildBracketView(bracket.id);
  }

  /**
   * Advance winners to next round after a week is finalized
   * Commissioner-only action
   */
  async advanceWinners(
    leagueId: number,
    week: number,
    userId: string,
    idempotencyKey?: string
  ): Promise<PlayoffBracketView> {
    // Idempotency check: return existing result if same key was already used
    if (idempotencyKey) {
      const existing = await this.db.query(
        `SELECT result FROM playoff_operations
         WHERE idempotency_key = $1 AND user_id = $2 AND operation_type = 'advance'
         AND expires_at > NOW()`,
        [idempotencyKey, userId]
      );
      if (existing.rows.length > 0) {
        return existing.rows[0].result;
      }
    }

    // Validate commissioner
    const isCommissioner = await this.leagueRepo.isCommissioner(leagueId, userId);
    if (!isCommissioner) {
      throw new ForbiddenException('Only the commissioner can advance playoff winners');
    }

    const league = await this.leagueRepo.findById(leagueId);
    if (!league) {
      throw new NotFoundException('League not found');
    }

    const season = parseInt(league.season, 10);
    const bracket = await this.playoffRepo.findByLeagueSeason(leagueId, season);
    if (!bracket) {
      throw new NotFoundException('No playoff bracket found');
    }

    // Only block if truly completed (all enabled winners set)
    // Allow continued processing if champion is set but other winners are pending
    if (bracket.status === 'completed') {
      // Double-check: are all required winners actually set?
      const isActuallyComplete = this.isBracketFullyComplete(bracket);
      if (isActuallyComplete) {
        throw new ValidationException('Playoffs are already completed');
      }
      // Otherwise allow processing for remaining games (3rd place, consolation)
    }

    // Get finalized matchups for this week by bracket type
    const winnersMatchups = await this.playoffRepo.getFinalizedMatchupsForWeekByType(
      leagueId, season, week, 'WINNERS'
    );
    const consolationMatchups = await this.playoffRepo.getFinalizedMatchupsForWeekByType(
      leagueId, season, week, 'CONSOLATION'
    );
    const thirdPlaceMatchups = await this.playoffRepo.getFinalizedMatchupsForWeekByType(
      leagueId, season, week, 'THIRD_PLACE'
    );

    if (winnersMatchups.length === 0 && consolationMatchups.length === 0 && thirdPlaceMatchups.length === 0) {
      throw new ValidationException('No finalized playoff matchups found for this week');
    }

    await runWithLock(this.db, LockDomain.LEAGUE, leagueId, async (client) => {
      // Advance WINNERS bracket
      if (winnersMatchups.length > 0) {
        await this.advanceWinnersBracket(
          client, leagueId, season, bracket, winnersMatchups, week
        );
      }

      // Advance CONSOLATION bracket
      if (consolationMatchups.length > 0 && bracket.consolationType === 'CONSOLATION') {
        await this.advanceConsolationBracket(
          client, leagueId, season, bracket, consolationMatchups, week
        );
      }

      // Handle 3rd place game finalization
      if (thirdPlaceMatchups.length > 0 && bracket.enableThirdPlace) {
        // Explicitly select 3rd place matchup by round and bracket position
        const thirdPlaceMatchup = thirdPlaceMatchups.find(
          (m) => m.playoff_round === bracket.totalRounds && m.bracket_position === 2
        );
        if (thirdPlaceMatchup) {
          const thirdPlaceWinnerId = this.determineWinner(thirdPlaceMatchup, true);
          await this.playoffRepo.setThirdPlaceWinner(bracket.id, thirdPlaceWinnerId, client);
          // Check if all winners are set and finalize if complete
          await this.playoffRepo.finalizeBracketIfComplete(bracket.id, client);
          logger.info(`League ${leagueId} 3rd place won by roster ${thirdPlaceWinnerId}`);
        } else {
          logger.warn(`3rd place matchup not found for league ${leagueId} (expected round=${bracket.totalRounds}, position=2)`);
        }
      }

      // Update bracket status to active if still pending
      if (bracket.status === 'pending') {
        await this.playoffRepo.updateStatus(bracket.id, 'active', client);
      }
    });

    // Emit event AFTER transaction
    this.emitWinnersAdvanced(leagueId, week);

    const bracketView = await this.buildBracketView(bracket.id);

    // Store result for idempotency
    if (idempotencyKey) {
      await this.db.query(
        `INSERT INTO playoff_operations (idempotency_key, bracket_id, league_id, user_id, operation_type, result)
         VALUES ($1, $2, $3, $4, 'advance', $5)
         ON CONFLICT (idempotency_key, user_id, operation_type) DO NOTHING`,
        [idempotencyKey, bracket.id, leagueId, userId, JSON.stringify(bracketView)]
      );
    }

    return bracketView;
  }

  /**
   * Advance winners bracket including 3rd place game creation
   * Now supports multi-week series with aggregate scoring
   */
  private async advanceWinnersBracket(
    client: PoolClient,
    leagueId: number,
    season: number,
    bracket: PlayoffBracket,
    matchups: any[],
    week: number
  ): Promise<void> {
    // Validate all matchups are from the same round
    this.validateSingleRound(matchups, 'WINNERS');

    const currentRound = matchups[0].playoff_round;
    const isSemifinals = currentRound === bracket.totalRounds - 1;
    const isChampionship = currentRound === bracket.totalRounds;

    // Get completed series for this round
    const completedSeries = await this.playoffRepo.getFinalizedSeriesEndingInWeek(
      leagueId, season, week, 'WINNERS'
    );

    if (completedSeries.length === 0) {
      // No series completed this week - might be game 1 of multi-week series
      logger.info(`League ${leagueId} week ${week}: No completed WINNERS series to advance`);
      return;
    }

    if (isChampionship) {
      // Find championship series
      const championshipSeries = completedSeries[0]; // Should only be one
      if (!championshipSeries) {
        throw new ValidationException('Championship series not found');
      }

      const winnerId = this.determineSeriesWinner(championshipSeries);
      await this.playoffRepo.setChampion(bracket.id, winnerId, client);
      await this.playoffRepo.finalizeBracketIfComplete(bracket.id, client);
      this.emitChampionCrowned(leagueId, bracket.id, winnerId);
      logger.info(`League ${leagueId} championship won by roster ${winnerId} with aggregate ${championshipSeries.roster1TotalPoints}-${championshipSeries.roster2TotalPoints}`);
      return;
    }

    // Calculate next round week using weeksByRound
    const nextRound = currentRound + 1;
    const { weekStart: nextRoundWeekStart } = getWeekRangeForRound(
      bracket.startWeek, bracket.weeksByRound, nextRound
    );
    const nextRoundWeeks = bracket.weeksByRound?.[nextRound - 1] ?? 1;

    // Check if all series for this round are complete
    const allSeriesComplete = await this.playoffRepo.areAllSeriesCompleteForRound(
      leagueId, season, currentRound, 'WINNERS'
    );

    if (!allSeriesComplete) {
      logger.info(`League ${leagueId} round ${currentRound}: Not all WINNERS series complete yet`);
      return;
    }

    // Create 3rd place game if enabled and we just finished semifinals
    if (isSemifinals && bracket.enableThirdPlace) {
      await this.createThirdPlaceGameFromSeries(
        client, leagueId, season, bracket, completedSeries, nextRoundWeekStart, nextRoundWeeks
      );
    }

    // Check if next round matchups already exist
    const nextRoundExists = await this.playoffRepo.roundMatchupsExistForType(
      leagueId, season, nextRound, 'WINNERS'
    );

    if (!nextRoundExists) {
      // Create next round matchups with series support
      await this.createNextRoundMatchupsFromSeries(
        leagueId, season, bracket, completedSeries, nextRound,
        nextRoundWeekStart, nextRoundWeeks, 'WINNERS', client
      );
    }
  }

  /**
   * Create 3rd place game from semifinal losers
   */
  private async createThirdPlaceGame(
    client: PoolClient,
    leagueId: number,
    season: number,
    bracket: PlayoffBracket,
    semifinalMatchups: any[],
    championshipWeek: number
  ): Promise<void> {
    // Check if already exists
    const exists = await this.playoffRepo.roundMatchupsExistForType(
      leagueId, season, bracket.totalRounds, 'THIRD_PLACE'
    );
    if (exists) return; // Idempotent

    // Get losers from semifinals
    const losers: Array<{ rosterId: number; seed: number }> = [];

    for (const matchup of semifinalMatchups) {
      const loserId = this.determineLoser(matchup, true);
      const loserSeed = loserId === matchup.roster1_id
        ? matchup.playoff_seed1
        : matchup.playoff_seed2;
      losers.push({ rosterId: loserId, seed: loserSeed });
    }

    if (losers.length !== 2) {
      logger.warn(`Expected 2 semifinal losers, got ${losers.length}`);
      return;
    }

    // Sort by seed (lower seed gets position 1)
    losers.sort((a, b) => a.seed - b.seed);

    await this.playoffRepo.createPlayoffMatchup(
      leagueId,
      season,
      championshipWeek,
      losers[0].rosterId,
      losers[1].rosterId,
      bracket.totalRounds,  // Same round as championship
      losers[0].seed,
      losers[1].seed,
      2,                    // bracket_position = 2 (championship is position 1)
      'THIRD_PLACE',
      client
    );

    logger.info(`Created 3rd place game for league ${leagueId}`);
  }

  /**
   * Advance consolation bracket with series support
   */
  private async advanceConsolationBracket(
    client: PoolClient,
    leagueId: number,
    season: number,
    bracket: PlayoffBracket,
    matchups: any[],
    week: number
  ): Promise<void> {
    // Validate all matchups are from the same round
    this.validateSingleRound(matchups, 'CONSOLATION');

    const currentRound = matchups[0].playoff_round;
    const consolationTotalRounds = calculateTotalRounds(bracket.consolationTeams!);

    // Get completed series for this round
    const completedSeries = await this.playoffRepo.getFinalizedSeriesEndingInWeek(
      leagueId, season, week, 'CONSOLATION'
    );

    if (completedSeries.length === 0) {
      logger.info(`League ${leagueId} week ${week}: No completed CONSOLATION series to advance`);
      return;
    }

    // Check if consolation is complete
    if (currentRound === consolationTotalRounds) {
      const consolationFinalSeries = completedSeries[0];
      if (consolationFinalSeries) {
        const winnerId = this.determineSeriesWinner(consolationFinalSeries);
        await this.playoffRepo.setConsolationWinner(bracket.id, winnerId, client);
        await this.playoffRepo.finalizeBracketIfComplete(bracket.id, client);
        logger.info(`League ${leagueId} consolation won by roster ${winnerId}`);
      } else {
        logger.warn(`Consolation final series not found for league ${leagueId}`);
      }
      return;
    }

    // Check if all series for this round are complete
    const allSeriesComplete = await this.playoffRepo.areAllSeriesCompleteForRound(
      leagueId, season, currentRound, 'CONSOLATION'
    );

    if (!allSeriesComplete) {
      logger.info(`League ${leagueId} round ${currentRound}: Not all CONSOLATION series complete yet`);
      return;
    }

    // Calculate next round week
    const nextRound = currentRound + 1;
    const { weekStart: nextRoundWeekStart } = getWeekRangeForRound(
      bracket.startWeek, bracket.weeksByRound, nextRound
    );
    const nextRoundWeeks = bracket.weeksByRound?.[nextRound - 1] ?? 1;

    // Check if next round already exists
    const nextRoundExists = await this.playoffRepo.roundMatchupsExistForType(
      leagueId, season, nextRound, 'CONSOLATION'
    );
    if (nextRoundExists) return; // Idempotent

    // Create next round matchups for consolation with series support
    await this.createNextRoundMatchupsFromSeries(
      leagueId, season, bracket, completedSeries, nextRound,
      nextRoundWeekStart, nextRoundWeeks, 'CONSOLATION', client
    );
  }

  /**
   * Generic next round matchup creation for any bracket type
   */
  private async createNextRoundMatchupsForBracket(
    leagueId: number,
    season: number,
    bracket: PlayoffBracket,
    previousMatchups: any[],
    nextRound: number,
    nextWeek: number,
    bracketType: BracketType,
    client: PoolClient
  ): Promise<void> {
    // Get winners from previous matchups (require points for advancement)
    const winners = previousMatchups.map((matchup) => {
      const winnerId = this.determineWinner(matchup, true);
      return {
        rosterId: winnerId,
        seed: winnerId === matchup.roster1_id
          ? matchup.playoff_seed1
          : matchup.playoff_seed2,
        bracketPosition: matchup.bracket_position,
      };
    });

    // Handle 6-team format with byes
    const teamCount = bracketType === 'CONSOLATION'
      ? bracket.consolationTeams!
      : bracket.playoffTeams;

    if (teamCount === 6 && nextRound === 2) {
      // 6-team consolation: seeds 1-2 have byes, enter in round 2
      // Get persisted consolation seeds
      const consolationSeeds = await this.playoffRepo.getSeedsByType(bracket.id, 'CONSOLATION');
      const byeTeams = consolationSeeds.filter((s) => s.hasBye);

      // Sort winners by bracket position
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
          // Semifinal 1: #1 vs winner of 4v5 (bracket position 1)
          await this.playoffRepo.createPlayoffMatchup(
            leagueId,
            season,
            nextWeek,
            seed1.rosterId,
            winner4v5.rosterId,
            nextRound,
            1,
            winner4v5.seed,
            1, // bracket position
            bracketType,
            client
          );

          // Semifinal 2: #2 vs winner of 3v6 (bracket position 2)
          await this.playoffRepo.createPlayoffMatchup(
            leagueId,
            season,
            nextWeek,
            seed2.rosterId,
            winner3v6.rosterId,
            nextRound,
            2,
            winner3v6.seed,
            2, // bracket position
            bracketType,
            client
          );

          logger.info(`Created 6-team ${bracketType} round 2 with bye teams for league ${leagueId}`);
          return;
        }
      }
      // Fall through to standard advancement if bye handling fails
      logger.warn(`6-team ${bracketType} bye handling failed, falling back to standard advancement`);
    }

    // Standard bracket advancement
    winners.sort((a, b) => a.bracketPosition - b.bracketPosition);

    for (let i = 0; i < winners.length; i += 2) {
      if (i + 1 < winners.length) {
        const team1 = winners[i];
        const team2 = winners[i + 1];

        await this.playoffRepo.createPlayoffMatchup(
          leagueId,
          season,
          nextWeek,
          team1.rosterId,
          team2.rosterId,
          nextRound,
          team1.seed,
          team2.seed,
          Math.floor(i / 2) + 1,
          bracketType,
          client
        );
      }
    }
  }

  /**
   * Check if a bracket has all required winners set (fully complete)
   */
  private isBracketFullyComplete(bracket: PlayoffBracket): boolean {
    const hasChampion = bracket.championRosterId !== null;
    const needsThirdPlace = bracket.enableThirdPlace === true;
    const hasThirdPlace = bracket.thirdPlaceRosterId !== null;
    const needsConsolation = bracket.consolationType === 'CONSOLATION';
    const hasConsolation = bracket.consolationWinnerRosterId !== null;

    return hasChampion
      && (!needsThirdPlace || hasThirdPlace)
      && (!needsConsolation || hasConsolation);
  }

  /**
   * Validate that all matchups are from the same playoff round.
   * Prevents advancing matchups that span multiple rounds.
   */
  private validateSingleRound(matchups: any[], bracketType: string): void {
    if (matchups.length === 0) return;

    const rounds = new Set(matchups.map((m) => m.playoff_round));
    if (rounds.size > 1) {
      throw new ValidationException(
        `Cannot advance playoffs: ${bracketType} matchups span multiple rounds (${[...rounds].join(', ')})`
      );
    }
  }

  /**
   * Determine winner of a matchup with tie-breaker.
   * @param matchup The matchup to determine winner for
   * @param requirePoints If true, throws if points are missing (for advancement flows)
   */
  private determineWinner(matchup: any, requirePoints: boolean = false): number {
    const p1 = matchup.roster1_points;
    const p2 = matchup.roster2_points;

    // Guard: If advancing, points must exist
    if (requirePoints) {
      if (p1 === null || p1 === undefined || p2 === null || p2 === undefined) {
        throw new ValidationException(
          `Cannot advance playoffs: matchup ${matchup.id} is finalized but missing scores`
        );
      }
    }

    const pts1 = p1 === null || p1 === undefined ? 0 : parseFloat(p1);
    const pts2 = p2 === null || p2 === undefined ? 0 : parseFloat(p2);

    if (pts1 > pts2) return matchup.roster1_id;
    if (pts2 > pts1) return matchup.roster2_id;
    // Tie: higher seed (lower number) wins
    return matchup.playoff_seed1 < matchup.playoff_seed2
      ? matchup.roster1_id
      : matchup.roster2_id;
  }

  /**
   * Determine loser of a matchup.
   * @param matchup The matchup to determine loser for
   * @param requirePoints If true, throws if points are missing (for advancement flows)
   */
  private determineLoser(matchup: any, requirePoints: boolean = false): number {
    const winnerId = this.determineWinner(matchup, requirePoints);
    return winnerId === matchup.roster1_id ? matchup.roster2_id : matchup.roster1_id;
  }

  /**
   * Determine winner of a series using aggregate scoring.
   * Tie-breaker: lower seed number (higher seed) wins.
   */
  private determineSeriesWinner(series: SeriesAggregation): number {
    if (series.roster1TotalPoints > series.roster2TotalPoints) {
      return series.roster1Id;
    }
    if (series.roster2TotalPoints > series.roster1TotalPoints) {
      return series.roster2Id;
    }
    // Tie: lower seed number wins
    return series.roster1Seed < series.roster2Seed
      ? series.roster1Id
      : series.roster2Id;
  }

  /**
   * Determine loser of a series using aggregate scoring.
   */
  private determineSeriesLoser(series: SeriesAggregation): number {
    const winnerId = this.determineSeriesWinner(series);
    return winnerId === series.roster1Id ? series.roster2Id : series.roster1Id;
  }

  /**
   * Create next round matchups from completed series
   */
  private async createNextRoundMatchupsFromSeries(
    leagueId: number,
    season: number,
    bracket: PlayoffBracket,
    completedSeries: SeriesAggregation[],
    nextRound: number,
    nextRoundWeekStart: number,
    nextRoundWeeks: number,
    bracketType: BracketType,
    client: PoolClient
  ): Promise<void> {
    // Get winners from completed series
    const winners = await Promise.all(completedSeries.map(async (series) => {
      const winnerId = this.determineSeriesWinner(series);
      const winnerSeed = winnerId === series.roster1Id
        ? series.roster1Seed
        : series.roster2Seed;

      // Get bracket position from the first game of the series
      const seriesMatchups = await this.playoffRepo.getSeriesMatchups(series.seriesId);
      const bracketPosition = seriesMatchups[0]?.bracket_position ?? 0;

      return {
        rosterId: winnerId,
        seed: winnerSeed,
        bracketPosition,
      };
    }));

    // Handle 6-team format with byes
    const teamCount = bracketType === 'CONSOLATION'
      ? bracket.consolationTeams!
      : bracket.playoffTeams;

    if (teamCount === 6 && nextRound === 2) {
      // Get bye teams
      const seedsType = bracketType === 'CONSOLATION' ? 'CONSOLATION' : 'WINNERS';
      const seeds = await this.playoffRepo.getSeedsByType(bracket.id, seedsType);
      const byeTeams = seeds.filter((s) => s.hasBye);

      winners.sort((a, b) => a.bracketPosition - b.bracketPosition);

      const winner4v5 = winners.find((w) => w.bracketPosition === 2);
      const winner3v6 = winners.find((w) => w.bracketPosition === 1);

      if (byeTeams.length >= 2 && winner4v5 && winner3v6) {
        const seed1 = byeTeams.find((s) => s.seed === 1);
        const seed2 = byeTeams.find((s) => s.seed === 2);

        if (seed1 && seed2) {
          // Create series for semifinal 1
          const series1Id = nextRoundWeeks > 1 ? uuidv4() : null;
          for (let game = 1; game <= nextRoundWeeks; game++) {
            const gameWeek = nextRoundWeekStart + game - 1;
            await this.playoffRepo.createPlayoffMatchupWithSeries(
              leagueId, season, gameWeek,
              seed1.rosterId, winner4v5.rosterId,
              nextRound, 1, winner4v5.seed, 1,
              bracketType, series1Id, game, nextRoundWeeks, client
            );
          }

          // Create series for semifinal 2
          const series2Id = nextRoundWeeks > 1 ? uuidv4() : null;
          for (let game = 1; game <= nextRoundWeeks; game++) {
            const gameWeek = nextRoundWeekStart + game - 1;
            await this.playoffRepo.createPlayoffMatchupWithSeries(
              leagueId, season, gameWeek,
              seed2.rosterId, winner3v6.rosterId,
              nextRound, 2, winner3v6.seed, 2,
              bracketType, series2Id, game, nextRoundWeeks, client
            );
          }

          logger.info(`Created 6-team ${bracketType} round ${nextRound} with bye teams for league ${leagueId}`);
          return;
        }
      }
      logger.warn(`6-team ${bracketType} bye handling failed, falling back to standard advancement`);
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
            leagueId, season, gameWeek,
            team1.rosterId, team2.rosterId,
            nextRound, team1.seed, team2.seed,
            Math.floor(i / 2) + 1,
            bracketType, seriesId, game, nextRoundWeeks, client
          );
        }
      }
    }
  }

  /**
   * Create 3rd place game from semifinal series losers
   */
  private async createThirdPlaceGameFromSeries(
    client: PoolClient,
    leagueId: number,
    season: number,
    bracket: PlayoffBracket,
    semifinalSeries: SeriesAggregation[],
    championshipWeekStart: number,
    championshipWeeks: number
  ): Promise<void> {
    // Check if already exists
    const exists = await this.playoffRepo.roundMatchupsExistForType(
      leagueId, season, bracket.totalRounds, 'THIRD_PLACE'
    );
    if (exists) return; // Idempotent

    // Get losers from semifinal series
    const losers = semifinalSeries.map((series) => {
      const loserId = this.determineSeriesLoser(series);
      const loserSeed = loserId === series.roster1Id
        ? series.roster1Seed
        : series.roster2Seed;
      return { rosterId: loserId, seed: loserSeed };
    });

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
        leagueId, season, gameWeek,
        losers[0].rosterId, losers[1].rosterId,
        bracket.totalRounds,
        losers[0].seed, losers[1].seed,
        2, // bracket_position = 2 (championship is position 1)
        'THIRD_PLACE',
        seriesId, game, championshipWeeks, client
      );
    }

    logger.info(`Created 3rd place series for league ${leagueId}`);
  }

  /**
   * Create matchups for the next playoff round
   */
  private async createNextRoundMatchups(
    leagueId: number,
    season: number,
    bracket: any,
    previousMatchups: any[],
    nextRound: number,
    nextWeek: number,
    client: any
  ): Promise<void> {
    const seeds = await this.playoffRepo.getSeeds(bracket.id);

    // Get winners from previous matchups (require points for advancement)
    const winners: Array<{ rosterId: number; seed: number; bracketPosition: number }> = [];

    for (const matchup of previousMatchups) {
      const winnerId = this.determineWinner(matchup, true);
      const winnerSeed =
        winnerId === matchup.roster1_id ? matchup.playoff_seed1 : matchup.playoff_seed2;

      winners.push({
        rosterId: winnerId,
        seed: winnerSeed,
        bracketPosition: matchup.bracket_position,
      });
    }

    // Handle 6-team format with byes
    if (bracket.playoffTeams === 6 && nextRound === 2) {
      // Add bye teams (seeds 1 and 2)
      const byeTeams = seeds.filter((s) => s.hasBye);

      // Sort winners by bracket position
      winners.sort((a, b) => a.bracketPosition - b.bracketPosition);

      // Semifinal 1: #1 seed vs winner of 4v5 (bracket position 2)
      const winner4v5 = winners.find((w) => w.bracketPosition === 2);
      // Semifinal 2: #2 seed vs winner of 3v6 (bracket position 1)
      const winner3v6 = winners.find((w) => w.bracketPosition === 1);

      if (byeTeams.length >= 2 && winner4v5 && winner3v6) {
        const seed1 = byeTeams.find((s) => s.seed === 1);
        const seed2 = byeTeams.find((s) => s.seed === 2);

        if (seed1 && seed2) {
          // Semifinal 1: #1 vs lower seed winner
          await this.playoffRepo.createPlayoffMatchup(
            leagueId,
            season,
            nextWeek,
            seed1.rosterId,
            winner4v5.rosterId,
            nextRound,
            1,
            winner4v5.seed,
            3,
            'WINNERS',
            client
          );

          // Semifinal 2: #2 vs higher seed winner
          await this.playoffRepo.createPlayoffMatchup(
            leagueId,
            season,
            nextWeek,
            seed2.rosterId,
            winner3v6.rosterId,
            nextRound,
            2,
            winner3v6.seed,
            4,
            'WINNERS',
            client
          );
        }
      }
    } else {
      // Standard bracket advancement
      // Pair winners: position 1 winner vs position 2 winner, position 3 vs position 4, etc.
      winners.sort((a, b) => a.bracketPosition - b.bracketPosition);

      for (let i = 0; i < winners.length; i += 2) {
        if (i + 1 < winners.length) {
          const team1 = winners[i];
          const team2 = winners[i + 1];

          await this.playoffRepo.createPlayoffMatchup(
            leagueId,
            season,
            nextWeek,
            team1.rosterId,
            team2.rosterId,
            nextRound,
            team1.seed,
            team2.seed,
            Math.floor(i / 2) + 1,
            'WINNERS',
            client
          );
        }
      }
    }
  }

  /**
   * Build complete bracket view with all rounds and matchups
   */
  private async buildBracketView(bracketId: number): Promise<PlayoffBracketView> {
    const bracket = await this.playoffRepo.findById(bracketId);
    if (!bracket) {
      throw new NotFoundException('Bracket not found');
    }

    const seeds = await this.playoffRepo.getSeeds(bracketId);

    // Get matchups by bracket type
    const winnersMatchupsRaw = await this.playoffRepo.getPlayoffMatchupsByType(
      bracket.leagueId, bracket.season, 'WINNERS'
    );
    const thirdPlaceMatchupsRaw = await this.playoffRepo.getPlayoffMatchupsByType(
      bracket.leagueId, bracket.season, 'THIRD_PLACE'
    );
    const consolationMatchupsRaw = await this.playoffRepo.getPlayoffMatchupsByType(
      bracket.leagueId, bracket.season, 'CONSOLATION'
    );

    // Build seed lookup
    const seedByRoster = new Map(seeds.map((s) => [s.rosterId, s]));

    // Build winners bracket rounds
    const rounds = this.buildRoundsFromMatchups(
      winnersMatchupsRaw, seedByRoster, bracket, 'WINNERS'
    );

    // Build 3rd place matchup
    let thirdPlace: { matchup: PlayoffMatchup } | null = null;
    if (thirdPlaceMatchupsRaw.length > 0) {
      const m = thirdPlaceMatchupsRaw[0];
      const matchup = this.buildPlayoffMatchup(m, seedByRoster, 'THIRD_PLACE');
      thirdPlace = { matchup };
    }

    // Build consolation bracket
    let consolation: { seeds: ConsolationSeed[]; rounds: PlayoffRound[] } | null = null;
    if (bracket.consolationType === 'CONSOLATION') {
      const consolationTotalRounds = calculateTotalRounds(bracket.consolationTeams!);
      const consolationRounds = this.buildConsolationRounds(
        consolationMatchupsRaw, bracket, consolationTotalRounds
      );
      // Get persisted consolation seeds (preferred) or extract from matchups (fallback)
      const persistedConsolationSeeds = await this.playoffRepo.getSeedsByType(bracket.id, 'CONSOLATION');
      let consolationSeeds: ConsolationSeed[];
      if (persistedConsolationSeeds.length > 0) {
        consolationSeeds = persistedConsolationSeeds.map((s) => ({
          rosterId: s.rosterId,
          standingsPosition: s.seed,
          teamName: s.teamName || `Team ${s.seed}`,
          record: s.regularSeasonRecord,
        }));
      } else {
        // Fallback for legacy brackets without persisted consolation seeds
        consolationSeeds = this.extractConsolationSeeds(consolationMatchupsRaw);
      }
      consolation = { seeds: consolationSeeds, rounds: consolationRounds };
    }

    // Get champion info
    let champion: PlayoffTeamInfo | null = null;
    if (bracket.championRosterId) {
      const championSeed = seedByRoster.get(bracket.championRosterId);
      if (championSeed) {
        champion = {
          rosterId: bracket.championRosterId,
          seed: championSeed.seed,
          teamName: championSeed.teamName || `Team ${championSeed.seed}`,
          points: null,
          record: championSeed.regularSeasonRecord,
        };
      }
    }

    // Build settings
    const settings: PlayoffSettings = {
      enableThirdPlaceGame: bracket.enableThirdPlace,
      consolationType: bracket.consolationType,
      consolationTeams: bracket.consolationTeams,
      weeksByRound: bracket.weeksByRound,
    };

    return {
      bracket,
      seeds,
      rounds,
      champion,
      thirdPlace,
      consolation,
      settings,
    };
  }

  /**
   * Build rounds array from matchups with series support
   */
  private buildRoundsFromMatchups(
    matchupsRaw: any[],
    seedByRoster: Map<number, any>,
    bracket: PlayoffBracket,
    bracketType: BracketType
  ): PlayoffRound[] {
    const matchupsByRound = new Map<number, PlayoffMatchup[]>();

    for (const m of matchupsRaw) {
      const playoffMatchup = this.buildPlayoffMatchup(m, seedByRoster, bracketType);

      const round = m.playoff_round;
      if (!matchupsByRound.has(round)) {
        matchupsByRound.set(round, []);
      }
      matchupsByRound.get(round)!.push(playoffMatchup);
    }

    const rounds: PlayoffRound[] = [];
    for (let r = 1; r <= bracket.totalRounds; r++) {
      const matchups = matchupsByRound.get(r) || [];
      matchups.sort((a, b) => a.bracketPosition - b.bracketPosition);

      // Calculate week range using weeksByRound
      const { weekStart, weekEnd } = getWeekRangeForRound(
        bracket.startWeek, bracket.weeksByRound, r
      );

      rounds.push({
        round: r,
        week: weekStart, // Backward compatible
        weekStart,
        weekEnd,
        name: getRoundName(bracket.playoffTeams, r, bracket.totalRounds),
        matchups,
      });
    }

    return rounds;
  }

  /**
   * Build consolation rounds for display with series support
   */
  private buildConsolationRounds(
    matchupsRaw: any[],
    bracket: PlayoffBracket,
    consolationTotalRounds: number
  ): PlayoffRound[] {
    const matchupsByRound = new Map<number, PlayoffMatchup[]>();

    for (const m of matchupsRaw) {
      const playoffMatchup: PlayoffMatchup = {
        matchupId: m.id,
        week: m.week,
        round: m.playoff_round,
        bracketPosition: m.bracket_position || 0,
        bracketType: 'CONSOLATION',
        team1: {
          rosterId: m.roster1_id,
          seed: m.playoff_seed1,
          teamName: m.roster1_team_name || `Team`,
          points: m.roster1_points === null ? null : parseFloat(m.roster1_points),
          record: '',
        },
        team2: {
          rosterId: m.roster2_id,
          seed: m.playoff_seed2,
          teamName: m.roster2_team_name || `Team`,
          points: m.roster2_points === null ? null : parseFloat(m.roster2_points),
          record: '',
        },
        winner: null,
        isFinal: m.is_final,
        seriesId: m.series_id ?? null,
        seriesGame: m.series_game ?? 1,
        seriesLength: m.series_length ?? 1,
      };

      // Determine winner if final
      if (m.is_final && playoffMatchup.team1 && playoffMatchup.team2) {
        const p1 = playoffMatchup.team1.points ?? 0;
        const p2 = playoffMatchup.team2.points ?? 0;
        playoffMatchup.winner = p1 >= p2 ? playoffMatchup.team1 : playoffMatchup.team2;
      }

      const round = m.playoff_round;
      if (!matchupsByRound.has(round)) {
        matchupsByRound.set(round, []);
      }
      matchupsByRound.get(round)!.push(playoffMatchup);
    }

    const rounds: PlayoffRound[] = [];
    for (let r = 1; r <= consolationTotalRounds; r++) {
      const matchups = matchupsByRound.get(r) || [];
      matchups.sort((a, b) => a.bracketPosition - b.bracketPosition);

      // Calculate week range using weeksByRound
      const { weekStart, weekEnd } = getWeekRangeForRound(
        bracket.startWeek, bracket.weeksByRound, r
      );

      rounds.push({
        round: r,
        week: weekStart,
        weekStart,
        weekEnd,
        name: getConsolationRoundName(bracket.consolationTeams!, r, consolationTotalRounds),
        matchups,
      });
    }

    return rounds;
  }

  /**
   * Extract consolation seeds from matchups
   */
  private extractConsolationSeeds(matchupsRaw: any[]): ConsolationSeed[] {
    const seedMap = new Map<number, ConsolationSeed>();

    for (const m of matchupsRaw) {
      if (!seedMap.has(m.roster1_id)) {
        seedMap.set(m.roster1_id, {
          rosterId: m.roster1_id,
          standingsPosition: m.playoff_seed1,
          teamName: m.roster1_team_name || `Team`,
          record: '',
        });
      }
      if (!seedMap.has(m.roster2_id)) {
        seedMap.set(m.roster2_id, {
          rosterId: m.roster2_id,
          standingsPosition: m.playoff_seed2,
          teamName: m.roster2_team_name || `Team`,
          record: '',
        });
      }
    }

    return Array.from(seedMap.values()).sort((a, b) => a.standingsPosition - b.standingsPosition);
  }

  /**
   * Build a single playoff matchup from raw data
   */
  private buildPlayoffMatchup(
    m: any,
    seedByRoster: Map<number, any>,
    bracketType: BracketType
  ): PlayoffMatchup {
    const seed1 = seedByRoster.get(m.roster1_id);
    const seed2 = seedByRoster.get(m.roster2_id);

    const team1: PlayoffTeamInfo | null = seed1
      ? {
          rosterId: m.roster1_id,
          seed: seed1.seed,
          teamName: m.roster1_team_name || seed1.teamName || `Team ${seed1.seed}`,
          points: m.roster1_points === null || m.roster1_points === undefined
            ? null
            : parseFloat(m.roster1_points),
          record: seed1.regularSeasonRecord,
        }
      : {
          rosterId: m.roster1_id,
          seed: m.playoff_seed1,
          teamName: m.roster1_team_name || `Team`,
          points: m.roster1_points === null ? null : parseFloat(m.roster1_points),
          record: '',
        };

    const team2: PlayoffTeamInfo | null = seed2
      ? {
          rosterId: m.roster2_id,
          seed: seed2.seed,
          teamName: m.roster2_team_name || seed2.teamName || `Team ${seed2.seed}`,
          points: m.roster2_points === null || m.roster2_points === undefined
            ? null
            : parseFloat(m.roster2_points),
          record: seed2.regularSeasonRecord,
        }
      : {
          rosterId: m.roster2_id,
          seed: m.playoff_seed2,
          teamName: m.roster2_team_name || `Team`,
          points: m.roster2_points === null ? null : parseFloat(m.roster2_points),
          record: '',
        };

    let winner: PlayoffTeamInfo | null = null;
    if (m.is_final && team1 && team2) {
      const p1 = team1.points ?? 0;
      const p2 = team2.points ?? 0;
      if (p1 > p2) {
        winner = team1;
      } else if (p2 > p1) {
        winner = team2;
      } else {
        winner = team1.seed < team2.seed ? team1 : team2;
      }
    }

    return {
      matchupId: m.id,
      week: m.week,
      round: m.playoff_round,
      bracketPosition: m.bracket_position || 0,
      bracketType,
      team1,
      team2,
      winner,
      isFinal: m.is_final,
      seriesId: m.series_id ?? null,
      seriesGame: m.series_game ?? 1,
      seriesLength: m.series_length ?? 1,
    };
  }

  /**
   * Generate consolation bracket matchups and persist consolation seeds
   */
  private async generateConsolationBracket(
    client: PoolClient,
    leagueId: number,
    season: number,
    startWeek: number,
    consolationTeams: number,
    standings: any[],
    playoffTeams: number,
    bracketId: number,
    weeksByRound: number[] | null
  ): Promise<void> {
    // Get non-playoff teams (those who didn't make playoffs)
    const nonPlayoffStandings = standings.slice(playoffTeams, playoffTeams + consolationTeams);

    // Determine which seeds get byes in 6-team format
    const byeSeeds = consolationTeams === 6 ? [1, 2] : [];

    // Persist consolation seeds for later use (especially for 6-team byes)
    const consolationSeedData = nonPlayoffStandings.map((standing, index) => ({
      rosterId: standing.rosterId,
      seed: index + 1,
      regularSeasonRecord: `${standing.wins}-${standing.losses}${standing.ties > 0 ? `-${standing.ties}` : ''}`,
      pointsFor: standing.pointsFor,
      hasBye: byeSeeds.includes(index + 1),
      bracketType: 'CONSOLATION' as const,
    }));

    await this.playoffRepo.createSeeds(bracketId, consolationSeedData, client);

    // Generate bracket config
    const bracketConfig = generateConsolationBracketConfig(consolationTeams, startWeek);

    // Create seed mapping (1 = first non-playoff team, etc.)
    const seedMap = new Map(
      nonPlayoffStandings.map((s, index) => [index + 1, s])
    );

    // Get weeks for round 1 of consolation (same as winners bracket)
    const round1Weeks = weeksByRound?.[0] ?? 1;

    for (const matchup of bracketConfig) {
      const team1 = seedMap.get(matchup.seed1);
      const team2 = matchup.seed2 ? seedMap.get(matchup.seed2) : null;

      if (!team1) continue;
      if (!team2) continue; // Skip bye matchups in round 1

      // Generate series_id for multi-week rounds
      const seriesId = round1Weeks > 1 ? uuidv4() : null;

      // Create matchup(s) for each game in the series
      for (let game = 1; game <= round1Weeks; game++) {
        const gameWeek = getWeekForRoundGame(startWeek, weeksByRound, 1, game);
        await this.playoffRepo.createPlayoffMatchupWithSeries(
          leagueId,
          season,
          gameWeek,
          team1.rosterId,
          team2.rosterId,
          matchup.round,
          matchup.seed1,
          matchup.seed2!,
          matchup.bracketPosition,
          'CONSOLATION',
          seriesId,
          game,
          round1Weeks,
          client
        );
      }
    }

    logger.info(`Generated ${consolationTeams}-team consolation bracket for league ${leagueId}`);
  }

  /**
   * Emit bracket generated event
   */
  private emitBracketGenerated(leagueId: number, bracketId: number): void {
    const eventBus = tryGetEventBus();
    eventBus?.publish({
      type: EventTypes.PLAYOFF_BRACKET_GENERATED,
      leagueId,
      payload: { bracketId },
    });
  }

  /**
   * Emit winners advanced event
   */
  private emitWinnersAdvanced(leagueId: number, week: number): void {
    const eventBus = tryGetEventBus();
    eventBus?.publish({
      type: EventTypes.PLAYOFF_WINNERS_ADVANCED,
      leagueId,
      payload: { week },
    });
  }

  /**
   * Emit champion crowned event
   */
  private emitChampionCrowned(leagueId: number, bracketId: number, championRosterId: number): void {
    const eventBus = tryGetEventBus();
    eventBus?.publish({
      type: EventTypes.PLAYOFF_CHAMPION_CROWNED,
      leagueId,
      payload: { bracketId, championRosterId },
    });
  }
}
