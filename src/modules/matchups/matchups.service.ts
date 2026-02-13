import { Pool, PoolClient } from 'pg';
import { MatchupsRepository } from './matchups.repository';
import type { LineupsRepository } from '../lineups/lineups.repository';
import type { LeagueRepository, RosterRepository } from '../leagues/leagues.repository';
import type { ScoringService } from '../scoring/scoring.service';
import type { PlayerStatsRepository } from '../scoring/scoring.repository';
import type { PlayerProjectionsRepository } from '../scoring/projections.repository';
import type { GameProgressService } from '../scoring/game-progress.service';
import type { ScoringRules } from '../scoring/scoring.model';
import { normalizeLeagueScoringSettings } from '../scoring/scoring-settings-normalizer';
import { calculatePlayerPoints } from '../scoring/scoring-calculator';
import type { PlayerRepository } from '../players/players.repository';
import { MedianService } from './median.service';
import type { BestballService } from '../bestball/bestball.service';
import {
  MatchupDetails,
  MatchupWithLineups,
  MatchupTeamLineup,
  MatchupPlayerPerformance,
} from './matchups.model';
import type { LineupSlots, PositionSlot } from '../lineups/lineups.model';
import {
  NotFoundException,
  ForbiddenException,
  ValidationException,
  BadRequestException,
} from '../../utils/exceptions';
import { runInTransaction, runWithLocks } from '../../shared/transaction-runner';
import { LockDomain } from '../../shared/locks';

/**
 * Core matchup service handling CRUD operations, detail fetching, and scoring updates.
 * Note: Schedule generation and standings are now handled directly by their respective services
 * (ScheduleGeneratorService and StandingsService) via the controller.
 */
export class MatchupService {
  constructor(
    private readonly db: Pool,
    private readonly matchupsRepo: MatchupsRepository,
    private readonly lineupsRepo: LineupsRepository,
    private readonly rosterRepo: RosterRepository,
    private readonly leagueRepo: LeagueRepository,
    private readonly scoringService: ScoringService,
    private readonly playerRepo: PlayerRepository,
    private readonly statsRepo: PlayerStatsRepository,
    private readonly projectionsRepo: PlayerProjectionsRepository,
    private readonly medianService?: MedianService,
    private readonly gameProgressService?: GameProgressService,
    private readonly bestballService?: BestballService
  ) {}

  /**
   * Get matchups for a week
   */
  async getWeekMatchups(leagueId: number, week: number, userId: string): Promise<MatchupDetails[]> {
    // Validate league membership
    const isMember = await this.leagueRepo.isUserMember(leagueId, userId);
    if (!isMember) {
      throw new ForbiddenException('You are not a member of this league');
    }

    const league = await this.leagueRepo.findById(leagueId);
    if (!league) {
      throw new NotFoundException('League not found');
    }

    const season = parseInt(league.season, 10);
    return this.matchupsRepo.findByLeagueAndWeekWithDetails(leagueId, season, week);
  }

  /**
   * Get all matchups for a season (no week filter)
   * Used for finding max scheduled week and getting full schedule
   */
  async getAllMatchups(
    leagueId: number,
    userId: string,
    seasonOverride?: number
  ): Promise<MatchupDetails[]> {
    // Validate league membership
    const isMember = await this.leagueRepo.isUserMember(leagueId, userId);
    if (!isMember) {
      throw new ForbiddenException('You are not a member of this league');
    }

    const league = await this.leagueRepo.findById(leagueId);
    if (!league) {
      throw new NotFoundException('League not found');
    }

    const season = seasonOverride ?? parseInt(league.season, 10);
    return this.matchupsRepo.findAllByLeagueAndSeasonWithDetails(leagueId, season);
  }

  /**
   * Get a single matchup with full details
   */
  async getMatchup(matchupId: number, userId: string): Promise<MatchupDetails | null> {
    // Use efficient single-matchup fetch instead of loading all week's matchups
    const matchup = await this.matchupsRepo.findByIdWithDetails(matchupId);
    if (!matchup) return null;

    // Validate league membership
    const isMember = await this.leagueRepo.isUserMember(matchup.leagueId, userId);
    if (!isMember) {
      throw new ForbiddenException('You are not a member of this league');
    }

    return matchup;
  }

  /**
   * Get a matchup with full lineup details for both teams
   */
  async getMatchupWithLineups(
    matchupId: number,
    userId: string
  ): Promise<MatchupWithLineups | null> {
    // Get basic matchup details first
    const matchupDetails = await this.getMatchup(matchupId, userId);
    if (!matchupDetails) return null;

    // Fetch league + lineups in parallel (avoid double-fetch in buildTeamLineup)
    const [league, lineup1, lineup2] = await Promise.all([
      this.leagueRepo.findById(matchupDetails.leagueId),
      this.lineupsRepo.findByRosterAndWeek(
        matchupDetails.roster1Id,
        matchupDetails.season,
        matchupDetails.week
      ),
      this.lineupsRepo.findByRosterAndWeek(
        matchupDetails.roster2Id,
        matchupDetails.season,
        matchupDetails.week
      ),
    ]);

    // Compute scoring rules once for both teams
    const { rules: scoringRules } = normalizeLeagueScoringSettings(league?.scoringSettings);

    // Build team lineups in parallel with shared scoring rules
    const [team1, team2] = await Promise.all([
      this.buildTeamLineup(
        matchupDetails.roster1Id,
        matchupDetails.roster1TeamName,
        lineup1?.lineup,
        matchupDetails.season,
        matchupDetails.week,
        matchupDetails.roster1Points,
        scoringRules
      ),
      this.buildTeamLineup(
        matchupDetails.roster2Id,
        matchupDetails.roster2TeamName,
        lineup2?.lineup,
        matchupDetails.season,
        matchupDetails.week,
        matchupDetails.roster2Points,
        scoringRules
      ),
    ]);

    return {
      ...matchupDetails,
      team1,
      team2,
    };
  }

  /**
   * Build team lineup with player details and points
   * @param scoringRules - Scoring rules passed in to avoid redundant league lookups
   */
  private async buildTeamLineup(
    rosterId: number,
    teamName: string,
    lineup: LineupSlots | undefined,
    season: number,
    week: number,
    totalPoints: number | null,
    scoringRules: ScoringRules
  ): Promise<MatchupTeamLineup> {
    if (!lineup) {
      return {
        rosterId,
        teamName,
        totalPoints: totalPoints ?? 0,
        players: [],
      };
    }

    // Derive starter slots dynamically from lineup keys (excludes BN, IR, TAXI)
    const reserveSlots = ['BN', 'IR', 'TAXI'];
    const starterSlots = (Object.keys(lineup) as PositionSlot[]).filter(
      (slot) => !reserveSlots.includes(slot) && Array.isArray(lineup[slot]) && lineup[slot].length > 0
    );

    // Collect all player IDs
    const allPlayerIds: number[] = [];
    for (const slot of starterSlots) {
      allPlayerIds.push(...(lineup[slot] || []));
    }
    allPlayerIds.push(...(lineup.BN || []));

    if (allPlayerIds.length === 0) {
      return {
        rosterId,
        teamName,
        totalPoints: totalPoints ?? 0,
        players: [],
      };
    }

    // Deduplicate player IDs before DB query to prevent duplicate fetches
    const uniquePlayerIds = [...new Set(allPlayerIds)];

    // Fetch players, stats, and projections in parallel
    const [players, stats, projections] = await Promise.all([
      this.playerRepo.findByIds(uniquePlayerIds),
      this.statsRepo.findByPlayersAndWeek(uniquePlayerIds, season, week),
      this.projectionsRepo.findByPlayersAndWeek(uniquePlayerIds, season, week),
    ]);

    // Create maps for lookup
    const playerMap = new Map(players.map((p) => [p.id, p]));
    const statsMap = new Map(stats.map((s) => [s.playerId, s]));
    const projectionsMap = new Map(projections.map((p) => [p.playerId, p]));

    // Fetch game status for all teams if GameProgressService is available
    let gameStatusMap: Map<string, { status: 'not_started' | 'in_progress' | 'final'; completionPercentage: number }> | undefined;
    if (this.gameProgressService) {
      const weekGameStatus = await this.gameProgressService.getWeekGameStatus(season, week);
      gameStatusMap = new Map();
      for (const [team, status] of weekGameStatus.entries()) {
        let gameStatus: 'not_started' | 'in_progress' | 'final';
        if (status.isComplete) {
          gameStatus = 'final';
        } else if (status.isInProgress) {
          gameStatus = 'in_progress';
        } else {
          gameStatus = 'not_started';
        }
        const completionPercentage = 1 - this.gameProgressService.getPercentRemaining(status);
        gameStatusMap.set(team, { status: gameStatus, completionPercentage });
      }
    }

    // Build player performance list
    const performances: MatchupPlayerPerformance[] = [];

    // Process starters
    for (const slot of starterSlots) {
      const playerIds = lineup[slot] || [];
      for (const playerId of playerIds) {
        const player = playerMap.get(playerId);
        const playerStats = statsMap.get(playerId);
        const points = playerStats
          ? calculatePlayerPoints(playerStats, scoringRules, player?.position)
          : 0;

        // Calculate projections
        const { projectedPoints, gameStatus, remainingProjected } = this.calculatePlayerProjection(
          player?.team ?? undefined,
          points,
          projectionsMap.get(playerId),
          gameStatusMap,
          scoringRules,
          player?.position ?? undefined
        );

        performances.push({
          playerId,
          fullName: player?.fullName || 'Unknown Player',
          position: player?.position || '',
          team: player?.team || null,
          slot,
          points,
          isStarter: true,
          projectedPoints,
          gameStatus,
          remainingProjected,
        });
      }
    }

    // Process bench
    const benchIds = lineup.BN || [];
    for (const playerId of benchIds) {
      const player = playerMap.get(playerId);
      const playerStats = statsMap.get(playerId);
      const points = playerStats
        ? calculatePlayerPoints(playerStats, scoringRules, player?.position)
        : 0;

      // Calculate projections
      const { projectedPoints, gameStatus, remainingProjected } = this.calculatePlayerProjection(
        player?.team ?? undefined,
        points,
        projectionsMap.get(playerId),
        gameStatusMap,
        scoringRules,
        player?.position ?? undefined
      );

      performances.push({
        playerId,
        fullName: player?.fullName || 'Unknown Player',
        position: player?.position || '',
        team: player?.team || null,
        slot: 'BN',
        points,
        isStarter: false,
        projectedPoints,
        gameStatus,
        remainingProjected,
      });
    }

    // Compute total from starters if stored total is null (matchup not yet finalized)
    const computedTotal = performances
      .filter((p) => p.isStarter)
      .reduce((sum, p) => sum + p.points, 0);

    return {
      rosterId,
      teamName,
      totalPoints: totalPoints ?? computedTotal,
      players: performances,
    };
  }

  /**
   * Calculate player projection based on game status and pre-game projections
   * @returns Object with projectedPoints, gameStatus, and remainingProjected
   */
  private calculatePlayerProjection(
    playerTeam: string | undefined,
    actualPoints: number,
    preGameProjectionStats: any,
    gameStatusMap: Map<string, { status: 'not_started' | 'in_progress' | 'final'; completionPercentage: number }> | undefined,
    scoringRules: ScoringRules,
    position?: string
  ): { projectedPoints?: number; gameStatus?: 'not_started' | 'in_progress' | 'final'; remainingProjected?: number } {
    // If no game status available, skip projections
    if (!gameStatusMap || !playerTeam) {
      return {};
    }

    const gameInfo = gameStatusMap.get(playerTeam);
    if (!gameInfo) {
      return {};
    }

    const { status, completionPercentage } = gameInfo;

    // Calculate pre-game projected points from projection stats
    let preGameProjectedPoints = 0;
    if (preGameProjectionStats) {
      preGameProjectedPoints = calculatePlayerPoints(preGameProjectionStats, scoringRules, position);
    }

    let projectedPoints: number | undefined;
    let remainingProjected: number | undefined;

    if (status === 'final') {
      // Game is complete - use actual points as projection
      projectedPoints = actualPoints;
      remainingProjected = 0;
    } else if (status === 'in_progress') {
      // Game is in progress - blend current pace with pre-game projection
      const currentPace = completionPercentage > 0.01
        ? actualPoints / completionPercentage
        : preGameProjectedPoints;

      // Blend: 70% current pace, 30% pre-game projection
      // This prevents wild swings while still adapting to game flow
      projectedPoints = (currentPace * 0.7) + (preGameProjectedPoints * 0.3);
      remainingProjected = Math.max(0, projectedPoints - actualPoints);
    } else {
      // Game not started - use pre-game projection
      projectedPoints = preGameProjectedPoints;
      remainingProjected = preGameProjectedPoints;
    }

    return {
      projectedPoints,
      gameStatus: status,
      remainingProjected,
    };
  }

  /**
   * Calculate and finalize matchup results for a week.
   * If league median is enabled, also calculates median results.
   */
  async finalizeWeekMatchups(leagueId: number, week: number, userId: string): Promise<void> {
    // Only commissioner can finalize matchups
    const isCommissioner = await this.leagueRepo.isCommissioner(leagueId, userId);
    if (!isCommissioner) {
      throw new ForbiddenException('Only the commissioner can finalize matchups');
    }

    const league = await this.leagueRepo.findById(leagueId);
    if (!league) {
      throw new NotFoundException('League not found');
    }

    const season = parseInt(league.season, 10);

    // Validate week is within scheduled range
    const maxWeek = await this.matchupsRepo.getMaxScheduledWeek(leagueId, season);
    if (maxWeek === null) {
      throw new ValidationException('No matchups have been scheduled for this league');
    }
    if (week > maxWeek) {
      throw new ValidationException(`Week ${week} is beyond the scheduled weeks (max: ${maxWeek})`);
    }

    // Guard: Check if NFL games are still in progress
    if (this.gameProgressService) {
      const gamesInProgress = await this.gameProgressService.hasGamesInProgress(season, week);
      if (gamesInProgress) {
        throw new BadRequestException(
          'Cannot finalize week while NFL games are still in progress. Please wait until all games are complete.'
        );
      }
    }

    // Regenerate bestball lineups using final stats before calculating scores
    if (league.leagueSettings?.rosterType === 'bestball' && this.bestballService) {
      await this.bestballService.generateBestballLineupsForLeague(leagueId, season, week, 'final');
    }

    // First calculate all scores (pass pre-fetched league to avoid redundant DB queries)
    await this.scoringService.calculateWeeklyScores(leagueId, week, userId, league);

    // Get all matchups for the week (outside lock — matchups don't change once created,
    // and we need them to compute rosterIds for the lock list)
    const matchups = await this.matchupsRepo.findByLeagueAndWeek(leagueId, season, week);

    // Guard against re-finalization
    if (matchups.length > 0 && matchups.every(m => m.isFinal)) {
      throw new ValidationException(`Week ${week} matchups are already finalized`);
    }

    // Check if league median is enabled and this is not a playoff week
    const useLeagueMedian = league.leagueSettings?.useLeagueMedian === true;
    const isPlayoffWeek = matchups.some((m) => m.isPlayoff);

    // Extract all roster IDs and acquire LINEUP locks to prevent concurrent edits
    const rosterIds = matchups.flatMap((m) => [m.roster1Id, m.roster2Id]);

    // Update matchup scores and finalize with LINEUP locks
    const locks = rosterIds.map(id => ({ domain: LockDomain.LINEUP, id }));
    await runWithLocks(this.db, locks, async (client: PoolClient) => {
      // Read lineups INSIDE the lock to prevent TOCTOU — lineup data could change
      // between the read and lock acquisition if read outside
      const lineups = await this.lineupsRepo.getByLeagueAndWeek(leagueId, season, week);
      const lineupMap = new Map(lineups.map((l) => [l.rosterId, l]));

      for (const matchup of matchups) {
        const lineup1 = lineupMap.get(matchup.roster1Id);
        const lineup2 = lineupMap.get(matchup.roster2Id);

        const roster1Points = lineup1?.totalPoints || 0;
        const roster2Points = lineup2?.totalPoints || 0;

        await this.matchupsRepo.updatePoints(matchup.id, roster1Points, roster2Points, client);

        await this.matchupsRepo.finalize(matchup.id, client);
      }

      // Calculate and store median results if enabled and not playoff
      if (useLeagueMedian && !isPlayoffWeek && this.medianService) {
        await this.medianService.calculateAndStoreMedianResults(client, leagueId, season, week);
      }
    });
  }
}
