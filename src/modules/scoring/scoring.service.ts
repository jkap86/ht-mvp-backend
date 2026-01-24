import { Pool } from 'pg';
import { PlayerStatsRepository } from './scoring.repository';
import { LineupsRepository } from '../lineups/lineups.repository';
import { LeagueRepository } from '../leagues/leagues.repository';
import {
  PlayerStats,
  ScoringRules,
  DEFAULT_SCORING_RULES,
  ScoringType,
} from './scoring.model';
import { LineupSlots } from '../lineups/lineups.model';
import {
  NotFoundException,
  ForbiddenException,
} from '../../utils/exceptions';

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
   */
  calculatePlayerPoints(stats: PlayerStats, rules: ScoringRules): number {
    let points = 0;

    // Passing
    points += stats.passYards * rules.passYards;
    points += stats.passTd * rules.passTd;
    points += stats.passInt * rules.passInt;

    // Rushing
    points += stats.rushYards * rules.rushYards;
    points += stats.rushTd * rules.rushTd;

    // Receiving
    points += stats.receptions * rules.receptions;
    points += stats.recYards * rules.recYards;
    points += stats.recTd * rules.recTd;

    // Misc
    points += stats.fumblesLost * rules.fumblesLost;
    points += stats.twoPtConversions * rules.twoPtConversions;

    // Kicking
    points += stats.fgMade * rules.fgMade;
    points += stats.fgMissed * rules.fgMissed;
    points += stats.patMade * rules.patMade;
    points += stats.patMissed * rules.patMissed;

    // Defense
    points += stats.defTd * rules.defTd;
    points += stats.defInt * rules.defInt;
    points += stats.defSacks * rules.defSack;
    points += stats.defFumbleRec * rules.defFumbleRec;
    points += stats.defSafety * rules.defSafety;

    // Defense points allowed
    points += this.getDefensePointsAllowedScore(stats.defPointsAllowed, rules);

    return Math.round(points * 100) / 100; // Round to 2 decimal places
  }

  /**
   * Get defense points allowed score
   */
  private getDefensePointsAllowedScore(pointsAllowed: number, rules: ScoringRules): number {
    if (pointsAllowed === 0) return rules.defPointsAllowed0;
    if (pointsAllowed <= 6) return rules.defPointsAllowed1to6;
    if (pointsAllowed <= 13) return rules.defPointsAllowed7to13;
    if (pointsAllowed <= 20) return rules.defPointsAllowed14to20;
    if (pointsAllowed <= 27) return rules.defPointsAllowed21to27;
    if (pointsAllowed <= 34) return rules.defPointsAllowed28to34;
    return rules.defPointsAllowed35plus;
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
    const statsMap = new Map(stats.map(s => [s.playerId, s]));

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

    // Calculate and store points for each lineup
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');

      for (const lineup of lineups) {
        const { total } = await this.calculateLineupPoints(lineup.lineup, season, week, rules);
        await this.lineupsRepo.updatePoints(lineup.rosterId, season, week, total, client);
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
    userId: string
  ): Promise<PlayerStats | null> {
    return this.statsRepo.findByPlayerAndWeek(playerId, season, week);
  }

  /**
   * Get player stats for a season
   */
  async getPlayerSeasonStats(
    playerId: number,
    season: number,
    userId: string
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
