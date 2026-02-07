import { Pool } from 'pg';
import { PlayerStatsRepository } from './scoring.repository';
import { PlayerProjectionsRepository } from './projections.repository';
import { LineupsRepository } from '../lineups/lineups.repository';
import { LeagueRepository } from '../leagues/leagues.repository';
import { PlayerRepository } from '../players/players.repository';
import { GameProgressService, TeamGameStatus } from './game-progress.service';
import { PlayerStats, ScoringRules, ScoringType, DEFAULT_SCORING_RULES } from './scoring.model';
import { normalizeLeagueScoringSettings } from './scoring-settings-normalizer';
import { LineupSlots, RosterLineup } from '../lineups/lineups.model';
import { NotFoundException, ForbiddenException } from '../../utils/exceptions';
import {
  calculatePlayerPoints as calculatePlayerPointsPure,
  calculateRemainingStats,
  calculateProjectedBonuses,
} from './scoring-calculator';
import { logger } from '../../config/env.config';

export class ScoringService {
  private projectionsRepo?: PlayerProjectionsRepository;
  private playerRepo?: PlayerRepository;
  private gameProgressService?: GameProgressService;

  constructor(
    private readonly db: Pool,
    private readonly statsRepo: PlayerStatsRepository,
    private readonly lineupsRepo: LineupsRepository,
    private readonly leagueRepo: LeagueRepository
  ) {}

  /**
   * Configure optional dependencies for live scoring
   * These are optional to maintain backwards compatibility
   */
  configureLiveScoring(
    projectionsRepo: PlayerProjectionsRepository,
    playerRepo: PlayerRepository,
    gameProgressService: GameProgressService
  ): void {
    this.projectionsRepo = projectionsRepo;
    this.playerRepo = playerRepo;
    this.gameProgressService = gameProgressService;
  }

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

    const { rules } = normalizeLeagueScoringSettings(league.scoringSettings);
    return rules;
  }

  /**
   * Calculate points for a player's stats
   * Delegates to pure scoring calculator for single source of truth
   * @param position - Optional player position for TE premium
   */
  calculatePlayerPoints(stats: PlayerStats, rules: ScoringRules, position?: string | null): number {
    return calculatePlayerPointsPure(stats, rules, position);
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

    // Get stats and player data for all starters
    const [stats, players] = await Promise.all([
      this.statsRepo.findByPlayersAndWeek(starterIds, season, week),
      this.playerRepo ? this.playerRepo.findByIds(starterIds) : Promise.resolve([]),
    ]);
    const statsMap = new Map(stats.map((s) => [s.playerId, s]));
    const positionMap = new Map(players.map((p) => [p.id, p.position]));

    // Calculate points for each player
    const playerPoints = new Map<number, number>();
    let total = 0;

    for (const playerId of starterIds) {
      const playerStats = statsMap.get(playerId);
      if (playerStats) {
        const position = positionMap.get(playerId);
        const points = this.calculatePlayerPoints(playerStats, rules, position);
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

  // ============================================================
  // LIVE SCORING METHODS
  // ============================================================

  /**
   * Get all starter player IDs from a lineup
   */
  private getStarterIds(lineup: LineupSlots): number[] {
    return [
      ...(lineup.QB || []),
      ...(lineup.RB || []),
      ...(lineup.WR || []),
      ...(lineup.TE || []),
      ...(lineup.FLEX || []),
      ...(lineup.SUPER_FLEX || []),
      ...(lineup.REC_FLEX || []),
      ...(lineup.K || []),
      ...(lineup.DEF || []),
      ...(lineup.DL || []),
      ...(lineup.LB || []),
      ...(lineup.DB || []),
      ...(lineup.IDP_FLEX || []),
    ];
  }

  /**
   * Get scoring rules for a league without user validation
   * Used internally for batch operations
   */
  private async getScoringRulesInternal(leagueId: number): Promise<ScoringRules> {
    const league = await this.leagueRepo.findById(leagueId);
    if (!league) {
      throw new NotFoundException('League not found');
    }

    const { rules } = normalizeLeagueScoringSettings(league.scoringSettings);
    return rules;
  }

  /**
   * Calculate and update live actual totals for all lineups in a league
   * This calculates points from actual stats only (no projections)
   */
  async calculateWeeklyLiveActualTotalsForLeague(
    leagueId: number,
    season: number,
    week: number
  ): Promise<void> {
    const lineups = await this.lineupsRepo.getByLeagueAndWeek(leagueId, season, week);
    if (lineups.length === 0) return;

    const rules = await this.getScoringRulesInternal(leagueId);

    // Collect all starter IDs across all lineups
    const allStarterIds = new Set<number>();
    for (const lineup of lineups) {
      for (const playerId of this.getStarterIds(lineup.lineup)) {
        allStarterIds.add(playerId);
      }
    }

    const starterIdArray = Array.from(allStarterIds);

    // Batch fetch stats and player data
    const [stats, players] = await Promise.all([
      this.statsRepo.findByPlayersAndWeek(starterIdArray, season, week),
      this.playerRepo ? this.playerRepo.findByIds(starterIdArray) : Promise.resolve([]),
    ]);
    const statsMap = new Map(stats.map((s) => [s.playerId, s]));
    const positionMap = new Map(players.map((p) => [p.id, p.position]));

    // Calculate live totals for each lineup
    const updates: Array<{
      rosterId: number;
      season: number;
      week: number;
      liveActual: number;
      liveProjected: number;
    }> = [];

    for (const lineup of lineups) {
      const starterIds = this.getStarterIds(lineup.lineup);
      let total = 0;

      for (const playerId of starterIds) {
        const playerStats = statsMap.get(playerId);
        if (playerStats) {
          const position = positionMap.get(playerId);
          total += this.calculatePlayerPoints(playerStats, rules, position);
        }
      }

      updates.push({
        rosterId: lineup.rosterId,
        season,
        week,
        liveActual: Math.round(total * 100) / 100,
        liveProjected: lineup.totalPointsProjectedLive ?? 0, // Keep existing projected
      });
    }

    // Batch update all lineups
    await this.lineupsRepo.batchUpdateLivePoints(updates);

    logger.info(
      `Updated live actual totals for ${updates.length} lineups in league ${leagueId}`
    );
  }

  /**
   * Calculate and update live projected totals for all lineups in a league
   * Uses correct formula: projectedFinal = actualPoints + score(remainingStats) + projectedBonuses
   *
   * This properly calculates remaining stats per field rather than applying a
   * percentage to total projected points.
   */
  async calculateWeeklyLiveProjectedTotalsForLeague(
    leagueId: number,
    season: number,
    week: number
  ): Promise<void> {
    if (!this.projectionsRepo || !this.playerRepo || !this.gameProgressService) {
      logger.warn('Live scoring dependencies not configured, skipping projected totals');
      return;
    }

    const lineups = await this.lineupsRepo.getByLeagueAndWeek(leagueId, season, week);
    if (lineups.length === 0) return;

    const rules = await this.getScoringRulesInternal(leagueId);

    // Collect all starter IDs across all lineups
    const allStarterIds = new Set<number>();
    for (const lineup of lineups) {
      for (const playerId of this.getStarterIds(lineup.lineup)) {
        allStarterIds.add(playerId);
      }
    }

    const starterIdArray = Array.from(allStarterIds);

    // Batch fetch all data in parallel
    const [stats, projections, players, gameStatusMap] = await Promise.all([
      this.statsRepo.findByPlayersAndWeek(starterIdArray, season, week),
      this.projectionsRepo.findByPlayersAndWeek(starterIdArray, season, week),
      this.playerRepo.findByIds(starterIdArray),
      this.gameProgressService.getWeekGameStatus(season, week),
    ]);

    // Create lookup maps
    const statsMap = new Map(stats.map((s) => [s.playerId, s]));
    const projectionsMap = new Map(projections.map((p) => [p.playerId, p]));
    const playerTeamMap = new Map(players.map((p) => [p.id, p.team]));
    const positionMap = new Map(players.map((p) => [p.id, p.position]));

    // Calculate live projected totals for each lineup
    const updates: Array<{
      rosterId: number;
      season: number;
      week: number;
      liveActual: number;
      liveProjected: number;
    }> = [];

    for (const lineup of lineups) {
      const starterIds = this.getStarterIds(lineup.lineup);
      let actualTotal = 0;
      let projectedTotal = 0;

      for (const playerId of starterIds) {
        const actualStats = statsMap.get(playerId);
        const projStats = projectionsMap.get(playerId);
        const team = playerTeamMap.get(playerId);
        const position = positionMap.get(playerId);
        const gameStatus = team ? gameStatusMap.get(team) : undefined;

        // Calculate actual points
        const actualPoints = actualStats
          ? this.calculatePlayerPoints(actualStats, rules, position)
          : 0;
        actualTotal += actualPoints;

        // Determine projected final based on game state
        if (!gameStatus || (!gameStatus.isInProgress && !gameStatus.isComplete)) {
          // No game status info - check if we have actual stats
          if (actualStats && actualStats.passYards + actualStats.rushYards + actualStats.recYards > 0) {
            // Have stats but no game status - treat as complete to avoid snap-back
            projectedTotal += actualPoints;
          } else {
            // Game not started: use full projection
            projectedTotal += projStats
              ? this.calculatePlayerPoints(projStats, rules, position)
              : actualPoints;
          }
        } else if (gameStatus.isComplete) {
          // Game complete: projected = actual
          projectedTotal += actualPoints;
        } else {
          // Game in progress: actual + scaled(remaining stats) + projected bonuses
          if (actualStats && projStats) {
            const pctRemaining = this.gameProgressService!.getPercentRemaining(gameStatus);

            const remainingStats = calculateRemainingStats(actualStats, projStats);
            const remainingPoints = this.calculatePlayerPoints(remainingStats, rules, position);

            // Scale remaining points by time left in game
            const scaledRemaining = remainingPoints * pctRemaining;

            const projectedBonuses = calculateProjectedBonuses(actualStats, projStats, rules);
            projectedTotal += actualPoints + scaledRemaining + projectedBonuses;
          } else if (projStats) {
            // Have projection but no actual stats yet - use full projection
            projectedTotal += this.calculatePlayerPoints(projStats, rules, position);
          } else {
            projectedTotal += actualPoints;
          }
        }
      }

      updates.push({
        rosterId: lineup.rosterId,
        season,
        week,
        liveActual: Math.round(actualTotal * 100) / 100,
        liveProjected: Math.round(projectedTotal * 100) / 100,
      });
    }

    // Batch update all lineups
    await this.lineupsRepo.batchUpdateLivePoints(updates);

    logger.info(
      `Updated live projected totals for ${updates.length} lineups in league ${leagueId}`
    );
  }
}
