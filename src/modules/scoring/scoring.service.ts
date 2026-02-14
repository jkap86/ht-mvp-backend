import { Pool } from 'pg';
import { PlayerStatsRepository } from './scoring.repository';
import { PlayerProjectionsRepository } from './projections.repository';
import type { LineupsRepository } from '../lineups/lineups.repository';
import type { LeagueRepository } from '../leagues/leagues.repository';
import type { League } from '../leagues/leagues.model';
import type { PlayerRepository } from '../players/players.repository';
import { GameProgressService, TeamGameStatus } from './game-progress.service';
import { PlayerStats, ScoringRules, ScoringType, DEFAULT_SCORING_RULES } from './scoring.model';
import { normalizeLeagueScoringSettings } from './scoring-settings-normalizer';
import type { LineupSlots, RosterLineup } from '../lineups/lineups.model';
import { NotFoundException, ForbiddenException } from '../../utils/exceptions';
import {
  calculatePlayerPoints as calculatePlayerPointsPure,
  calculateRemainingStats,
  calculateProjectedBonuses,
  getDefensePointsAllowedScore,
} from './scoring-calculator';
import { logger } from '../../config/logger.config';
import { runInTransaction, runWithLock, runWithTryLock, LockDomain } from '../../shared/transaction-runner';
import { makeCompositeLockId } from '../../shared/locks';

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
   * @param prefetchedLeague - Optional pre-fetched league to avoid redundant DB queries.
   *   When provided, commissioner check is skipped (caller is responsible for authorization).
   */
  async calculateWeeklyScores(
    leagueId: number,
    week: number,
    userId: string,
    prefetchedLeague?: League
  ): Promise<void> {
    let league: League;

    if (prefetchedLeague) {
      league = prefetchedLeague;
    } else {
      // Only commissioner can calculate scores
      const isCommissioner = await this.leagueRepo.isCommissioner(leagueId, userId);
      if (!isCommissioner) {
        throw new ForbiddenException('Only the commissioner can calculate scores');
      }

      const fetched = await this.leagueRepo.findById(leagueId);
      if (!fetched) {
        throw new NotFoundException('League not found');
      }
      league = fetched;
    }

    const season = parseInt(league.season, 10);
    const { rules } = normalizeLeagueScoringSettings(league.scoringSettings);

    // Wrap read + calculate + write in LEAGUE lock to prevent TOCTOU race
    // with concurrent lineup edits (commissioner-triggered, runs once per week)
    await runWithLock(this.db, LockDomain.LEAGUE, leagueId, async (client) => {
      const lineups = await this.lineupsRepo.getByLeagueAndWeek(leagueId, season, week, client);

      // Calculate all lineup points in parallel for performance
      // (calculateLineupPoints reads stats via pool - fine since stats are immutable once written)
      const calculations = await Promise.all(
        lineups.map((lineup) => this.calculateLineupPoints(lineup.lineup, season, week, rules))
      );

      // Store points for each lineup
      for (let i = 0; i < lineups.length; i++) {
        const { total } = calculations[i];
        await this.lineupsRepo.updatePoints(lineups[i].rosterId, season, week, total, client);
      }
    });
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
   * Check if player has any meaningful stats (not just zeros)
   * Used for snap-back guard to detect DEF/K stats that don't involve yards
   */
  private hasAnyStats(stats: PlayerStats): boolean {
    return !!(
      stats.passYards || stats.passTd || stats.passInt ||
      stats.rushYards || stats.rushTd ||
      stats.receptions || stats.recYards || stats.recTd ||
      stats.fumblesLost || stats.twoPtConversions ||
      stats.fgMade || stats.fgMissed || stats.patMade || stats.patMissed ||
      stats.defTd || stats.defInt || stats.defSacks ||
      stats.defFumbleRec || stats.defSafety || stats.defPointsAllowed
    );
  }

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
   * Used internally for batch operations and by BestballService
   */
  async getScoringRulesInternal(leagueId: number): Promise<ScoringRules> {
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
    // Try-lock per league+week to skip if another process is already scoring this combination.
    // Prevents stale overwrites from overlapping runs on multi-dyno or restart overlap.
    const compositeId = makeCompositeLockId(leagueId, week);
    const scoringStart = Date.now();
    const result = await runWithTryLock(
      this.db,
      LockDomain.LIVE_SCORING_ACTUAL,
      compositeId,
      async (client) => {
        const lineups = await this.lineupsRepo.getByLeagueAndWeek(leagueId, season, week, client);
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

        // Batch fetch stats and player data (via pool - immutable data, no lock needed)
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
        await this.lineupsRepo.batchUpdateLivePoints(updates, client);

        logger.info('scoring:actual:updated', {
          leagueId,
          season,
          week,
          lineupsUpdated: updates.length,
          durationMs: Date.now() - scoringStart,
        });
      }
    );

    if (result === null) {
      logger.debug('scoring:actual:skipped', { leagueId, week, reason: 'lock_held' });
    }
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

    // Try-lock per league+week to skip if another process is already scoring this combination.
    // Prevents stale overwrites from overlapping runs on multi-dyno or restart overlap.
    const compositeId = makeCompositeLockId(leagueId, week);
    const result = await runWithTryLock(
      this.db,
      LockDomain.LIVE_SCORING_PROJECTED,
      compositeId,
      async (client) => {
        const lineups = await this.lineupsRepo.getByLeagueAndWeek(leagueId, season, week, client);
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

        // Batch fetch all data in parallel (via pool - immutable data, no lock needed)
        const [stats, projections, players, gameStatusMap] = await Promise.all([
          this.statsRepo.findByPlayersAndWeek(starterIdArray, season, week),
          this.projectionsRepo!.findByPlayersAndWeek(starterIdArray, season, week),
          this.playerRepo!.findByIds(starterIdArray),
          this.gameProgressService!.getWeekGameStatus(season, week),
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
              // No game status info - check if we have actual stats (including DEF/K)
              if (actualStats && this.hasAnyStats(actualStats)) {
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

                // DEF points-allowed is bucketed/nonlinear - handle with estimated final PA
                let defPointsAllowedDelta = 0;
                if (position === 'DEF') {
                  const actualPA = actualStats.defPointsAllowed ?? 0;
                  const projPA = projStats.defPointsAllowed ?? actualPA;

                  // Estimate final PA by interpolating based on time remaining
                  const estFinalPA = actualPA + Math.max(0, projPA - actualPA) * pctRemaining;

                  const actualPAPoints = getDefensePointsAllowedScore(actualPA, rules);
                  const estFinalPAPoints = getDefensePointsAllowedScore(estFinalPA, rules);

                  // Can be negative (more PA later lowers DEF points)
                  defPointsAllowedDelta = estFinalPAPoints - actualPAPoints;
                }

                const projectedBonuses = calculateProjectedBonuses(actualStats, projStats, rules);
                const scaledBonuses = projectedBonuses * pctRemaining;
                projectedTotal += actualPoints + scaledRemaining + scaledBonuses + defPointsAllowedDelta;
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
        await this.lineupsRepo.batchUpdateLivePoints(updates, client);

        logger.info(
          `Updated live projected totals for ${updates.length} lineups in league ${leagueId}`
        );
      }
    );

    if (result === null) {
      logger.debug(`Skipped live projected scoring: league=${leagueId} week=${week} (lock held)`);
    }
  }
}
