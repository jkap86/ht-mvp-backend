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
  calculateTotalRounds,
  getRoundName,
  getConsolationRoundName,
  generateBracketConfig,
  generateConsolationBracketConfig,
} from './playoff.model';
import {
  NotFoundException,
  ForbiddenException,
  ValidationException,
  ConflictException,
} from '../../utils/exceptions';
import { logger } from '../../config/env.config';
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
      enableThirdPlaceGame?: boolean;
      consolationType?: ConsolationType;
      consolationTeams?: number;
    }
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
    const lastPlayoffWeek = config.startWeek + totalRounds - 1;

    // Validate startWeek is not in the past
    if (config.startWeek < currentWeek) {
      throw new ValidationException(
        `Playoff start week (${config.startWeek}) cannot be before current week (${currentWeek})`
      );
    }

    // Check for existing bracket - block all regeneration
    const existingBracket = await this.playoffRepo.findByLeagueSeason(leagueId, season);
    if (existingBracket) {
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
      // Calculate rounds and championship week
      const totalRounds = calculateTotalRounds(config.playoffTeams);
      const championshipWeek = config.startWeek + totalRounds - 1;

      // Create bracket with new settings
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

      // Generate round 1 matchups
      const bracketConfig = generateBracketConfig(config.playoffTeams, config.startWeek);
      const seedMap = new Map(seeds.map((s) => [s.seed, s]));

      for (const matchup of bracketConfig) {
        const seed1 = seedMap.get(matchup.seed1);
        const seed2 = matchup.seed2 ? seedMap.get(matchup.seed2) : null;

        if (!seed1) continue;
        if (!seed2) continue; // Skip bye matchups in round 1

        await this.playoffRepo.createPlayoffMatchup(
          leagueId,
          season,
          matchup.week,
          seed1.rosterId,
          seed2.rosterId,
          matchup.round,
          matchup.seed1,
          matchup.seed2!,
          matchup.bracketPosition,
          'WINNERS',
          client
        );
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
          config.playoffTeams
        );
      }

      return bracket.id;
    });

    // Emit event AFTER transaction
    this.emitBracketGenerated(leagueId, bracketId);

    logger.info(`Generated ${config.playoffTeams}-team playoff bracket for league ${leagueId}`);

    // Return full bracket view
    return this.buildBracketView(bracketId);
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
    userId: string
  ): Promise<PlayoffBracketView> {
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

    if (bracket.status === 'completed') {
      throw new ValidationException('Playoffs are already completed');
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

    return this.buildBracketView(bracket.id);
  }

  /**
   * Advance winners bracket including 3rd place game creation
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
    const nextRound = currentRound + 1;
    const nextWeek = week + 1;
    const isSemifinals = currentRound === bracket.totalRounds - 1;
    const isChampionship = currentRound === bracket.totalRounds;

    if (isChampionship) {
      // Find championship matchup explicitly by round and bracket position
      const championship = matchups.find(
        (m) => m.playoff_round === bracket.totalRounds && m.bracket_position === 1
      );
      if (!championship) {
        throw new ValidationException('Championship matchup not found');
      }

      const winnerId = this.determineWinner(championship, true);
      await this.playoffRepo.setChampion(bracket.id, winnerId, client);
      this.emitChampionCrowned(leagueId, bracket.id, winnerId);
      logger.info(`League ${leagueId} championship won by roster ${winnerId}`);
      return;
    }

    // Create 3rd place game if enabled and we just finished semifinals
    if (isSemifinals && bracket.enableThirdPlace) {
      await this.createThirdPlaceGame(
        client, leagueId, season, bracket, matchups, nextWeek
      );
    }

    // Check if next round matchups already exist
    const nextRoundExists = await this.playoffRepo.roundMatchupsExistForType(
      leagueId, season, nextRound, 'WINNERS'
    );

    if (!nextRoundExists) {
      // Create next round matchups
      await this.createNextRoundMatchups(
        leagueId, season, bracket, matchups, nextRound, nextWeek, client
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
   * Advance consolation bracket
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
    const nextRound = currentRound + 1;
    const nextWeek = week + 1;

    // Check if consolation is complete
    if (currentRound === consolationTotalRounds) {
      // Find consolation final explicitly by round and bracket position
      const consolationFinal = matchups.find(
        (m) => m.playoff_round === consolationTotalRounds && m.bracket_position === 1
      );
      if (consolationFinal) {
        const winnerId = this.determineWinner(consolationFinal, true);
        await this.playoffRepo.setConsolationWinner(bracket.id, winnerId, client);
        logger.info(`League ${leagueId} consolation won by roster ${winnerId}`);
      } else {
        logger.warn(`Consolation final not found for league ${leagueId} (expected round=${consolationTotalRounds}, position=1)`);
      }
      return;
    }

    // Check if next round already exists
    const nextRoundExists = await this.playoffRepo.roundMatchupsExistForType(
      leagueId, season, nextRound, 'CONSOLATION'
    );
    if (nextRoundExists) return; // Idempotent

    // Create next round matchups for consolation
    await this.createNextRoundMatchupsForBracket(
      leagueId, season, bracket, matchups, nextRound, nextWeek, 'CONSOLATION', client
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
      // For consolation, we need to handle byes differently - get from standings
      // For now, use standard bracket advancement
      // TODO: Implement 6-team consolation bye handling if needed
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
    if (consolationMatchupsRaw.length > 0 && bracket.consolationType === 'CONSOLATION') {
      const consolationTotalRounds = calculateTotalRounds(bracket.consolationTeams!);
      const consolationRounds = this.buildConsolationRounds(
        consolationMatchupsRaw, bracket, consolationTotalRounds
      );
      // Consolation seeds are derived from standings position, not playoff seeds
      // For now, we extract from the matchups themselves
      const consolationSeeds = this.extractConsolationSeeds(consolationMatchupsRaw);
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
   * Build rounds array from matchups
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

      rounds.push({
        round: r,
        week: bracket.startWeek + r - 1,
        name: getRoundName(bracket.playoffTeams, r, bracket.totalRounds),
        matchups,
      });
    }

    return rounds;
  }

  /**
   * Build consolation rounds for display
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

      rounds.push({
        round: r,
        week: bracket.startWeek + r - 1,
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
    };
  }

  /**
   * Generate consolation bracket matchups
   */
  private async generateConsolationBracket(
    client: PoolClient,
    leagueId: number,
    season: number,
    startWeek: number,
    consolationTeams: number,
    standings: any[],
    playoffTeams: number
  ): Promise<void> {
    // Get non-playoff teams (those who didn't make playoffs)
    const nonPlayoffStandings = standings.slice(playoffTeams, playoffTeams + consolationTeams);

    // Generate bracket config
    const bracketConfig = generateConsolationBracketConfig(consolationTeams, startWeek);

    // Create seed mapping (1 = first non-playoff team, etc.)
    const seedMap = new Map(
      nonPlayoffStandings.map((s, index) => [index + 1, s])
    );

    for (const matchup of bracketConfig) {
      const team1 = seedMap.get(matchup.seed1);
      const team2 = matchup.seed2 ? seedMap.get(matchup.seed2) : null;

      if (!team1) continue;
      if (!team2) continue; // Skip bye matchups in round 1

      await this.playoffRepo.createPlayoffMatchup(
        leagueId,
        season,
        matchup.week,
        team1.rosterId,
        team2.rosterId,
        matchup.round,
        matchup.seed1,
        matchup.seed2!,
        matchup.bracketPosition,
        'CONSOLATION',
        client
      );
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
