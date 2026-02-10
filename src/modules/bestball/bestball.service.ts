/**
 * Bestball Service
 *
 * Handles automatic lineup optimization for bestball leagues.
 * Generates optimal starting lineups based on player points.
 */

import { Pool } from 'pg';
import { LeagueRepository, RosterRepository } from '../leagues/leagues.repository';
import { RosterPlayersRepository } from '../rosters/rosters.repository';
import { LineupsRepository } from '../lineups/lineups.repository';
import { PlayerStatsRepository } from '../scoring/scoring.repository';
import { PlayerProjectionsRepository } from '../scoring/projections.repository';
import { PlayerRepository } from '../players/players.repository';
import { ScoringService } from '../scoring/scoring.service';
import { LineupSlots, PositionSlot, DEFAULT_ROSTER_CONFIG } from '../lineups/lineups.model';
import { optimizeBestballLineup, OptimizeInput } from './bestball-optimizer';
import { logger } from '../../config/logger.config';

export type BestballMode = 'live_projected' | 'live_actual' | 'final';

export interface GenerateBestballParams {
  leagueId: number;
  rosterId: number; // global roster ID
  season: number;
  week: number;
  mode: BestballMode;
}

export class BestballService {
  constructor(
    private readonly db: Pool,
    private readonly leagueRepo: LeagueRepository,
    private readonly rosterRepo: RosterRepository,
    private readonly rosterPlayersRepo: RosterPlayersRepository,
    private readonly lineupsRepo: LineupsRepository,
    private readonly statsRepo: PlayerStatsRepository,
    private readonly projectionsRepo: PlayerProjectionsRepository,
    private readonly playerRepo: PlayerRepository,
    private readonly scoringService: ScoringService
  ) {}

  /**
   * Check if a league is configured for bestball
   */
  async isBestballLeague(leagueId: number): Promise<boolean> {
    const league = await this.leagueRepo.findById(leagueId);
    return league?.leagueSettings?.rosterType === 'bestball';
  }

  /**
   * Generate optimal bestball lineup for a single roster
   */
  async generateBestballLineup(params: GenerateBestballParams): Promise<LineupSlots | null> {
    const { leagueId, rosterId, season, week, mode } = params;

    const league = await this.leagueRepo.findById(leagueId);
    if (!league) {
      logger.warn(`Bestball: League ${leagueId} not found`);
      return null;
    }

    // Only generate for bestball leagues
    if (league.leagueSettings?.rosterType !== 'bestball') {
      return null;
    }

    // Get roster players
    const rosterPlayers = await this.rosterPlayersRepo.getByRosterId(rosterId);
    if (rosterPlayers.length === 0) {
      logger.warn(`Bestball: No players on roster ${rosterId}`);
      return null;
    }

    // Get current lineup to preserve IR/TAXI assignments
    const existingLineup = await this.lineupsRepo.findByRosterAndWeek(rosterId, season, week);
    const irPlayerIds = existingLineup?.lineup?.IR || [];
    const taxiPlayerIds = existingLineup?.lineup?.TAXI || [];
    const reservePlayerIds = new Set([...irPlayerIds, ...taxiPlayerIds]);

    // Filter to eligible players (not on IR/TAXI)
    const eligiblePlayers = rosterPlayers
      .filter((p) => !reservePlayerIds.has(p.playerId))
      .map((p) => ({ id: p.playerId, position: p.position || '' }));

    // Get slot counts from league config or defaults
    const rosterConfig = league.settings?.roster_config || {};
    const slotCounts: Partial<Record<PositionSlot, number>> = {
      QB: rosterConfig.QB ?? DEFAULT_ROSTER_CONFIG.QB,
      RB: rosterConfig.RB ?? DEFAULT_ROSTER_CONFIG.RB,
      WR: rosterConfig.WR ?? DEFAULT_ROSTER_CONFIG.WR,
      TE: rosterConfig.TE ?? DEFAULT_ROSTER_CONFIG.TE,
      FLEX: rosterConfig.FLEX ?? DEFAULT_ROSTER_CONFIG.FLEX,
      SUPER_FLEX: rosterConfig.SUPER_FLEX ?? DEFAULT_ROSTER_CONFIG.SUPER_FLEX,
      REC_FLEX: rosterConfig.REC_FLEX ?? DEFAULT_ROSTER_CONFIG.REC_FLEX,
      K: rosterConfig.K ?? DEFAULT_ROSTER_CONFIG.K,
      DEF: rosterConfig.DEF ?? DEFAULT_ROSTER_CONFIG.DEF,
      DL: rosterConfig.DL ?? DEFAULT_ROSTER_CONFIG.DL,
      LB: rosterConfig.LB ?? DEFAULT_ROSTER_CONFIG.LB,
      DB: rosterConfig.DB ?? DEFAULT_ROSTER_CONFIG.DB,
      IDP_FLEX: rosterConfig.IDP_FLEX ?? DEFAULT_ROSTER_CONFIG.IDP_FLEX,
    };

    // Build points map based on mode
    const pointsByPlayerId = await this.buildPointsMap(
      eligiblePlayers.map((p) => p.id),
      season,
      week,
      mode,
      leagueId
    );

    // Run optimizer
    const input: OptimizeInput = {
      slotCounts,
      players: eligiblePlayers,
      pointsByPlayerId,
    };

    const result = optimizeBestballLineup(input);

    // Preserve IR/TAXI from existing lineup
    result.lineupSlots.IR = irPlayerIds;
    result.lineupSlots.TAXI = taxiPlayerIds;

    // Persist the optimized lineup
    await this.lineupsRepo.upsertBestball(rosterId, season, week, result.lineupSlots);

    logger.debug(
      `Bestball: Generated lineup for roster ${rosterId} week ${week} (${result.starterPlayerIds.length} starters)`
    );

    return result.lineupSlots;
  }

  /**
   * Generate bestball lineups for all rosters in a league
   */
  async generateBestballLineupsForLeague(
    leagueId: number,
    season: number,
    week: number,
    mode: BestballMode
  ): Promise<void> {
    const league = await this.leagueRepo.findById(leagueId);
    if (!league) {
      logger.warn(`Bestball: League ${leagueId} not found`);
      return;
    }

    // Only generate for bestball leagues
    if (league.leagueSettings?.rosterType !== 'bestball') {
      return;
    }

    // Get all rosters in the league
    const rosters = await this.rosterRepo.findByLeagueId(leagueId);
    if (rosters.length === 0) {
      logger.warn(`Bestball: No rosters in league ${leagueId}`);
      return;
    }

    // Pre-fetch all roster players and stats for efficiency
    const allRosterIds = rosters.map((r) => r.id);
    const allPlayerIds: number[] = [];

    // Collect all player IDs across rosters
    for (const roster of rosters) {
      const players = await this.rosterPlayersRepo.getByRosterId(roster.id);
      for (const p of players) {
        allPlayerIds.push(p.playerId);
      }
    }

    // Batch fetch points for all players
    const uniquePlayerIds = [...new Set(allPlayerIds)];
    const allPointsByPlayerId = await this.buildPointsMap(
      uniquePlayerIds,
      season,
      week,
      mode,
      leagueId
    );

    // Get slot counts from league config
    const rosterConfig = league.settings?.roster_config || {};
    const slotCounts: Partial<Record<PositionSlot, number>> = {
      QB: rosterConfig.QB ?? DEFAULT_ROSTER_CONFIG.QB,
      RB: rosterConfig.RB ?? DEFAULT_ROSTER_CONFIG.RB,
      WR: rosterConfig.WR ?? DEFAULT_ROSTER_CONFIG.WR,
      TE: rosterConfig.TE ?? DEFAULT_ROSTER_CONFIG.TE,
      FLEX: rosterConfig.FLEX ?? DEFAULT_ROSTER_CONFIG.FLEX,
      SUPER_FLEX: rosterConfig.SUPER_FLEX ?? DEFAULT_ROSTER_CONFIG.SUPER_FLEX,
      REC_FLEX: rosterConfig.REC_FLEX ?? DEFAULT_ROSTER_CONFIG.REC_FLEX,
      K: rosterConfig.K ?? DEFAULT_ROSTER_CONFIG.K,
      DEF: rosterConfig.DEF ?? DEFAULT_ROSTER_CONFIG.DEF,
      DL: rosterConfig.DL ?? DEFAULT_ROSTER_CONFIG.DL,
      LB: rosterConfig.LB ?? DEFAULT_ROSTER_CONFIG.LB,
      DB: rosterConfig.DB ?? DEFAULT_ROSTER_CONFIG.DB,
      IDP_FLEX: rosterConfig.IDP_FLEX ?? DEFAULT_ROSTER_CONFIG.IDP_FLEX,
    };

    // Get existing lineups to preserve IR/TAXI
    const existingLineups = await this.lineupsRepo.getByLeagueAndWeek(leagueId, season, week);
    const lineupsByRosterId = new Map(existingLineups.map((l) => [l.rosterId, l]));

    // Generate lineup for each roster
    const updates: Array<{ rosterId: number; lineup: LineupSlots }> = [];

    for (const roster of rosters) {
      const rosterPlayers = await this.rosterPlayersRepo.getByRosterId(roster.id);
      if (rosterPlayers.length === 0) continue;

      // Get existing IR/TAXI
      const existingLineup = lineupsByRosterId.get(roster.id);
      const irPlayerIds = existingLineup?.lineup?.IR || [];
      const taxiPlayerIds = existingLineup?.lineup?.TAXI || [];
      const reservePlayerIds = new Set([...irPlayerIds, ...taxiPlayerIds]);

      // Filter to eligible players
      const eligiblePlayers = rosterPlayers
        .filter((p) => !reservePlayerIds.has(p.playerId))
        .map((p) => ({ id: p.playerId, position: p.position || '' }));

      // Filter points map to this roster's players
      const rosterPointsMap = new Map<number, number>();
      for (const p of eligiblePlayers) {
        rosterPointsMap.set(p.id, allPointsByPlayerId.get(p.id) || 0);
      }

      // Run optimizer
      const input: OptimizeInput = {
        slotCounts,
        players: eligiblePlayers,
        pointsByPlayerId: rosterPointsMap,
      };

      const result = optimizeBestballLineup(input);

      // Preserve IR/TAXI
      result.lineupSlots.IR = irPlayerIds;
      result.lineupSlots.TAXI = taxiPlayerIds;

      updates.push({ rosterId: roster.id, lineup: result.lineupSlots });
    }

    // Batch update lineups
    if (updates.length > 0) {
      await this.lineupsRepo.batchUpsertBestball(updates, season, week);
      logger.info(
        `Bestball: Generated ${updates.length} lineups for league ${leagueId} week ${week} (mode: ${mode})`
      );
    }
  }

  /**
   * Build a points map for players based on the mode
   */
  private async buildPointsMap(
    playerIds: number[],
    season: number,
    week: number,
    mode: BestballMode,
    leagueId: number
  ): Promise<Map<number, number>> {
    const pointsMap = new Map<number, number>();

    if (playerIds.length === 0) return pointsMap;

    // Get scoring rules for the league
    const rules = await this.scoringService.getScoringRulesInternal(leagueId);

    // Get player positions for TE premium
    const players = await this.playerRepo.findByIds(playerIds);
    const positionMap = new Map(players.map((p) => [p.id, p.position]));

    if (mode === 'live_actual' || mode === 'final') {
      // Use actual stats
      const stats = await this.statsRepo.findByPlayersAndWeek(playerIds, season, week);
      for (const stat of stats) {
        const position = positionMap.get(stat.playerId);
        const points = this.scoringService.calculatePlayerPoints(stat, rules, position);
        pointsMap.set(stat.playerId, points);
      }
    } else {
      // mode === 'live_projected'
      // Use projections (or actuals if projections unavailable)
      const [stats, projections] = await Promise.all([
        this.statsRepo.findByPlayersAndWeek(playerIds, season, week),
        this.projectionsRepo.findByPlayersAndWeek(playerIds, season, week),
      ]);

      const statsMap = new Map(stats.map((s) => [s.playerId, s]));
      const projectionsMap = new Map(projections.map((p) => [p.playerId, p]));

      for (const playerId of playerIds) {
        const projection = projectionsMap.get(playerId);
        const actual = statsMap.get(playerId);
        const position = positionMap.get(playerId);

        // Prefer projection if available, fall back to actual, then 0
        const statSource = projection || actual;
        if (statSource) {
          const points = this.scoringService.calculatePlayerPoints(statSource, rules, position);
          pointsMap.set(playerId, points);
        } else {
          pointsMap.set(playerId, 0);
        }
      }
    }

    // Ensure all players have a value (default 0)
    for (const playerId of playerIds) {
      if (!pointsMap.has(playerId)) {
        pointsMap.set(playerId, 0);
      }
    }

    return pointsMap;
  }
}
