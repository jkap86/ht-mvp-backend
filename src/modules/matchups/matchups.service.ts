import { Pool } from 'pg';
import { MatchupsRepository } from './matchups.repository';
import { LineupsRepository } from '../lineups/lineups.repository';
import { LeagueRepository, RosterRepository } from '../leagues/leagues.repository';
import { ScoringService } from '../scoring/scoring.service';
import { PlayerStatsRepository } from '../scoring/scoring.repository';
import { GameProgressService } from '../scoring/game-progress.service';
import { ScoringRules } from '../scoring/scoring.model';
import { normalizeLeagueScoringSettings } from '../scoring/scoring-settings-normalizer';
import { calculatePlayerPoints } from '../scoring/scoring-calculator';
import { PlayerRepository } from '../players/players.repository';
import { MedianService } from './median.service';
import { BestballService } from '../bestball/bestball.service';
import {
  MatchupDetails,
  MatchupWithLineups,
  MatchupTeamLineup,
  MatchupPlayerPerformance,
} from './matchups.model';
import { LineupSlots, PositionSlot } from '../lineups/lineups.model';
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

    // Fetch players and stats in parallel
    const [players, stats] = await Promise.all([
      this.playerRepo.findByIds(uniquePlayerIds),
      this.statsRepo.findByPlayersAndWeek(uniquePlayerIds, season, week),
    ]);

    // Create maps for lookup
    const playerMap = new Map(players.map((p) => [p.id, p]));
    const statsMap = new Map(stats.map((s) => [s.playerId, s]));

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

        performances.push({
          playerId,
          fullName: player?.fullName || 'Unknown Player',
          position: player?.position || '',
          team: player?.team || null,
          slot,
          points,
          isStarter: true,
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

      performances.push({
        playerId,
        fullName: player?.fullName || 'Unknown Player',
        position: player?.position || '',
        team: player?.team || null,
        slot: 'BN',
        points,
        isStarter: false,
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

    // First calculate all scores
    await this.scoringService.calculateWeeklyScores(leagueId, week, userId);

    // Get all matchups for the week
    const matchups = await this.matchupsRepo.findByLeagueAndWeek(leagueId, season, week);

    // Get all lineups for the week
    const lineups = await this.lineupsRepo.getByLeagueAndWeek(leagueId, season, week);
    const lineupMap = new Map(lineups.map((l) => [l.rosterId, l]));

    // Check if league median is enabled and this is not a playoff week
    const useLeagueMedian = league.leagueSettings?.useLeagueMedian === true;
    const isPlayoffWeek = matchups.some((m) => m.isPlayoff);

    // Extract all roster IDs and acquire LINEUP locks to prevent concurrent edits
    const rosterIds = matchups.flatMap((m) => [m.roster1Id, m.roster2Id]);

    // Update matchup scores and finalize with LINEUP locks
    await runWithLocks(this.db, LockDomain.LINEUP, rosterIds, async (client) => {
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
