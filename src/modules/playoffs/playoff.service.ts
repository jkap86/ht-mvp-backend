import { Pool } from 'pg';
import { PlayoffRepository } from './playoff.repository';
import { MatchupsRepository } from '../matchups/matchups.repository';
import { LeagueRepository, RosterRepository } from '../leagues/leagues.repository';
import {
  PlayoffBracketView,
  PlayoffMatchup,
  PlayoffRound,
  PlayoffTeamInfo,
  calculateTotalRounds,
  getRoundName,
  generateBracketConfig,
} from './playoff.model';
import {
  NotFoundException,
  ForbiddenException,
  ValidationException,
  ConflictException,
} from '../../utils/exceptions';
import { logger } from '../../config/env.config';

export class PlayoffService {
  constructor(
    private readonly db: Pool,
    private readonly playoffRepo: PlayoffRepository,
    private readonly matchupsRepo: MatchupsRepository,
    private readonly leagueRepo: LeagueRepository,
    private readonly rosterRepo: RosterRepository
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

    // Check for existing bracket - block all regeneration
    const existingBracket = await this.playoffRepo.findByLeagueSeason(leagueId, season);
    if (existingBracket) {
      throw new ConflictException(
        'Playoff bracket already exists for this season. Use the regenerate endpoint to recreate.'
      );
    }

    // Get standings for seeding
    const standings = await this.matchupsRepo.getStandings(leagueId, season);
    if (standings.length < config.playoffTeams) {
      throw new ValidationException(
        `Not enough teams for playoffs. Need ${config.playoffTeams}, have ${standings.length}`
      );
    }

    const client = await this.db.connect();
    try {
      await client.query('BEGIN');

      // Calculate rounds and championship week
      const totalRounds = calculateTotalRounds(config.playoffTeams);
      const championshipWeek = config.startWeek + totalRounds - 1;

      // Create bracket
      const bracket = await this.playoffRepo.createBracket(
        leagueId,
        season,
        config.playoffTeams,
        totalRounds,
        config.startWeek,
        championshipWeek,
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
          client
        );
      }

      await client.query('COMMIT');

      logger.info(`Generated ${config.playoffTeams}-team playoff bracket for league ${leagueId}`);

      // Return full bracket view
      return this.buildBracketView(bracket.id);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
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

    // Get finalized matchups for this week
    const matchups = await this.playoffRepo.getFinalizedMatchupsForWeek(leagueId, season, week);

    if (matchups.length === 0) {
      throw new ValidationException('No finalized playoff matchups found for this week');
    }

    const client = await this.db.connect();
    try {
      await client.query('BEGIN');

      // Determine current round from matchups
      const currentRound = matchups[0].playoff_round;
      const nextRound = currentRound + 1;
      const nextWeek = week + 1;

      // Check if this is the championship
      if (currentRound === bracket.totalRounds) {
        // Find championship winner
        const championship = matchups[0];
        const winnerId =
          championship.roster1_points > championship.roster2_points
            ? championship.roster1_id
            : championship.roster2_id;

        await this.playoffRepo.setChampion(bracket.id, winnerId, client);
        logger.info(`League ${leagueId} championship won by roster ${winnerId}`);
      } else {
        // Check if next round matchups already exist
        const nextRoundExists = await this.playoffRepo.roundMatchupsExist(
          leagueId,
          season,
          nextRound
        );

        if (!nextRoundExists) {
          // Create next round matchups
          await this.createNextRoundMatchups(
            leagueId,
            season,
            bracket,
            matchups,
            nextRound,
            nextWeek,
            client
          );
        }

        // Update bracket status to active if still pending
        if (bracket.status === 'pending') {
          await this.playoffRepo.updateStatus(bracket.id, 'active', client);
        }
      }

      await client.query('COMMIT');

      return this.buildBracketView(bracket.id);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
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

    // Get winners from previous matchups
    const winners: Array<{ rosterId: number; seed: number; bracketPosition: number }> = [];

    for (const matchup of previousMatchups) {
      const winnerId =
        matchup.roster1_points > matchup.roster2_points ? matchup.roster1_id : matchup.roster2_id;
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
    const matchupsRaw = await this.playoffRepo.getPlayoffMatchups(bracket.leagueId, bracket.season);

    // Build seed lookup
    const seedByRoster = new Map(seeds.map((s) => [s.rosterId, s]));

    // Group matchups by round
    const matchupsByRound = new Map<number, PlayoffMatchup[]>();

    for (const m of matchupsRaw) {
      const seed1 = seedByRoster.get(m.roster1_id);
      const seed2 = seedByRoster.get(m.roster2_id);

      const team1: PlayoffTeamInfo | null = seed1
        ? {
            rosterId: m.roster1_id,
            seed: seed1.seed,
            teamName: m.roster1_team_name || seed1.teamName || `Team ${seed1.seed}`,
            points: m.roster1_points ? parseFloat(m.roster1_points) : null,
            record: seed1.regularSeasonRecord,
          }
        : null;

      const team2: PlayoffTeamInfo | null = seed2
        ? {
            rosterId: m.roster2_id,
            seed: seed2.seed,
            teamName: m.roster2_team_name || seed2.teamName || `Team ${seed2.seed}`,
            points: m.roster2_points ? parseFloat(m.roster2_points) : null,
            record: seed2.regularSeasonRecord,
          }
        : null;

      let winner: PlayoffTeamInfo | null = null;
      if (m.is_final && team1 && team2) {
        winner = m.roster1_points > m.roster2_points ? team1 : team2;
      }

      const playoffMatchup: PlayoffMatchup = {
        matchupId: m.id,
        week: m.week,
        round: m.playoff_round,
        bracketPosition: m.bracket_position || 0,
        team1,
        team2,
        winner,
        isFinal: m.is_final,
      };

      const round = m.playoff_round;
      if (!matchupsByRound.has(round)) {
        matchupsByRound.set(round, []);
      }
      matchupsByRound.get(round)!.push(playoffMatchup);
    }

    // Build rounds array
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

    return {
      bracket,
      seeds,
      rounds,
      champion,
    };
  }
}
