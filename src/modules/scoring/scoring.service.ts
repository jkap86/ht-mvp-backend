import { Pool } from 'pg';
import { PlayerStatsRepository } from './scoring.repository';
import { LineupsRepository } from '../lineups/lineups.repository';
import { LeagueRepository } from '../leagues/leagues.repository';
import { PlayerStats, ScoringRules, DEFAULT_SCORING_RULES, ScoringType } from './scoring.model';
import { LineupSlots } from '../lineups/lineups.model';
import { NotFoundException, ForbiddenException } from '../../utils/exceptions';
import { calculatePlayerPoints as calculatePlayerPointsPure } from './scoring-calculator';

export class ScoringService {
  constructor(
    private readonly db: Pool,
    private readonly statsRepo: PlayerStatsRepository,
    private readonly lineupsRepo: LineupsRepository,
    private readonly leagueRepo: LeagueRepository
  ) {}

  /**
   * Get scoring rules for a league
   */
  async getScoringRules(leagueId: number, userId: string): Promise<ScoringRules> {
    // Validate league membership
    const isMember = await this.leagueRepo.isUserMember(leagueId, userId);
    if (!isMember) {
      throw new ForbiddenException('You are not a member of this league');
    }

    const league = await this.leagueRepo.findById(leagueId);
    if (!league) {
      throw new NotFoundException('League not found');
    }

    // Get scoring type from league settings
    const scoringType: ScoringType = league.scoringSettings?.type || 'ppr';
    const customRules = league.scoringSettings?.rules;

    if (customRules) {
      // Merge custom rules with defaults
      return {
        ...DEFAULT_SCORING_RULES[scoringType],
        ...customRules,
      };
    }

    return DEFAULT_SCORING_RULES[scoringType];
  }

  /**
   * Calculate points for a player's stats
   * Delegates to pure scoring calculator for single source of truth
   */
  calculatePlayerPoints(stats: PlayerStats, rules: ScoringRules): number {
    return calculatePlayerPointsPure(stats, rules);
  }

  /**
   * Calculate total points for a lineup
   */
  async calculateLineupPoints(
    lineup: LineupSlots,
    season: number,
    week: number,
    rules: ScoringRules
  ): Promise<{ total: number; playerPoints: Map<number, number> }> {
    // Get all starter player IDs
    const starterIds = [
      ...lineup.QB,
      ...lineup.RB,
      ...lineup.WR,
      ...lineup.TE,
      ...lineup.FLEX,
      ...lineup.K,
      ...lineup.DEF,
    ];

    // Get stats for all starters
    const stats = await this.statsRepo.findByPlayersAndWeek(starterIds, season, week);
    const statsMap = new Map(stats.map((s) => [s.playerId, s]));

    // Calculate points for each player
    const playerPoints = new Map<number, number>();
    let total = 0;

    for (const playerId of starterIds) {
      const playerStats = statsMap.get(playerId);
      if (playerStats) {
        const points = this.calculatePlayerPoints(playerStats, rules);
        playerPoints.set(playerId, points);
        total += points;
      } else {
        playerPoints.set(playerId, 0);
      }
    }

    return { total: Math.round(total * 100) / 100, playerPoints };
  }

  /**
   * Calculate and store weekly scores for all rosters in a league
   */
  async calculateWeeklyScores(leagueId: number, week: number, userId: string): Promise<void> {
    // Only commissioner can calculate scores
    const isCommissioner = await this.leagueRepo.isCommissioner(leagueId, userId);
    if (!isCommissioner) {
      throw new ForbiddenException('Only the commissioner can calculate scores');
    }

    const league = await this.leagueRepo.findById(leagueId);
    if (!league) {
      throw new NotFoundException('League not found');
    }

    const season = parseInt(league.season, 10);
    const rules = await this.getScoringRules(leagueId, userId);

    // Get all lineups for the week
    const lineups = await this.lineupsRepo.getByLeagueAndWeek(leagueId, season, week);

    // Calculate all lineup points in parallel for performance
    const calculations = await Promise.all(
      lineups.map((lineup) => this.calculateLineupPoints(lineup.lineup, season, week, rules))
    );

    // Store points for each lineup (sequential within transaction)
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');

      for (let i = 0; i < lineups.length; i++) {
        const { total } = calculations[i];
        await this.lineupsRepo.updatePoints(lineups[i].rosterId, season, week, total, client);
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Get player stats for a week
   */
  async getPlayerStats(
    playerId: number,
    season: number,
    week: number,
    _userId: string
  ): Promise<PlayerStats | null> {
    return this.statsRepo.findByPlayerAndWeek(playerId, season, week);
  }

  /**
   * Get player stats for a season
   */
  async getPlayerSeasonStats(
    playerId: number,
    season: number,
    _userId: string
  ): Promise<PlayerStats[]> {
    return this.statsRepo.findByPlayerAndSeason(playerId, season);
  }

  /**
   * Get default scoring rules by type
   */
  getDefaultRules(type: ScoringType): ScoringRules {
    return DEFAULT_SCORING_RULES[type];
  }
}
