import { Pool } from 'pg';
import { LineupsRepository } from './lineups.repository';
import { RosterPlayersRepository } from '../rosters/rosters.repository';
import { LeagueRepository, RosterRepository } from '../leagues/leagues.repository';
import { RosterLineup, LineupSlots, LineupValidationResult, DEFAULT_ROSTER_CONFIG } from './lineups.model';
import {
  NotFoundException,
  ForbiddenException,
  ValidationException,
} from '../../utils/exceptions';

export class LineupService {
  constructor(
    private readonly db: Pool,
    private readonly lineupsRepo: LineupsRepository,
    private readonly rosterPlayersRepo: RosterPlayersRepository,
    private readonly rosterRepo: RosterRepository,
    private readonly leagueRepo: LeagueRepository
  ) {}

  /**
   * Get lineup for a roster/week (creates default if doesn't exist)
   */
  async getLineup(
    leagueId: number,
    rosterId: number,
    week: number,
    userId: string
  ): Promise<RosterLineup> {
    // Validate league membership
    const isMember = await this.leagueRepo.isUserMember(leagueId, userId);
    if (!isMember) {
      throw new ForbiddenException('You are not a member of this league');
    }

    // Validate roster exists
    const roster = await this.rosterRepo.findById(rosterId);
    if (!roster || roster.leagueId !== leagueId) {
      throw new NotFoundException('Roster not found');
    }

    const league = await this.leagueRepo.findById(leagueId);
    if (!league) {
      throw new NotFoundException('League not found');
    }

    const season = parseInt(league.season, 10);

    // Try to get existing lineup
    let lineup = await this.lineupsRepo.findByRosterAndWeek(rosterId, season, week);

    // If doesn't exist, create default
    if (!lineup) {
      const defaultLineup: LineupSlots = {
        QB: [],
        RB: [],
        WR: [],
        TE: [],
        FLEX: [],
        K: [],
        DEF: [],
        BN: [],
      };

      // Put all roster players on bench initially
      const rosterPlayers = await this.rosterPlayersRepo.getByRosterId(rosterId);
      defaultLineup.BN = rosterPlayers.map(p => p.playerId);

      lineup = await this.lineupsRepo.upsert(rosterId, season, week, defaultLineup);
    }

    return lineup;
  }

  /**
   * Set lineup for a roster/week
   */
  async setLineup(
    leagueId: number,
    rosterId: number,
    week: number,
    lineup: LineupSlots,
    userId: string
  ): Promise<RosterLineup> {
    // Validate user owns this roster
    const roster = await this.rosterRepo.findById(rosterId);
    if (!roster || roster.leagueId !== leagueId) {
      throw new NotFoundException('Roster not found');
    }

    if (roster.userId !== userId) {
      throw new ForbiddenException('You can only manage your own lineup');
    }

    const league = await this.leagueRepo.findById(leagueId);
    if (!league) {
      throw new NotFoundException('League not found');
    }

    const season = parseInt(league.season, 10);

    // Check if lineup is locked
    const isLocked = await this.lineupsRepo.isLocked(rosterId, season, week);
    if (isLocked) {
      throw new ValidationException('Lineup is locked and cannot be modified');
    }

    // Validate lineup
    const rosterPlayers = await this.rosterPlayersRepo.getByRosterId(rosterId);
    const validation = this.validateLineup(lineup, rosterPlayers, league.settings?.roster_config);

    if (!validation.valid) {
      throw new ValidationException(validation.errors.join(', '));
    }

    return this.lineupsRepo.upsert(rosterId, season, week, lineup);
  }

  /**
   * Move a player between slots
   */
  async movePlayer(
    leagueId: number,
    rosterId: number,
    week: number,
    playerId: number,
    toSlot: string,
    userId: string
  ): Promise<RosterLineup> {
    // Get current lineup
    const currentLineup = await this.getLineup(leagueId, rosterId, week, userId);

    // Validate user owns this roster
    const roster = await this.rosterRepo.findById(rosterId);
    if (!roster || roster.userId !== userId) {
      throw new ForbiddenException('You can only manage your own lineup');
    }

    const league = await this.leagueRepo.findById(leagueId);
    if (!league) {
      throw new NotFoundException('League not found');
    }

    const season = parseInt(league.season, 10);

    // Check if lineup is locked
    const isLocked = await this.lineupsRepo.isLocked(rosterId, season, week);
    if (isLocked) {
      throw new ValidationException('Lineup is locked and cannot be modified');
    }

    // Get player position
    const rosterPlayers = await this.rosterPlayersRepo.getByRosterId(rosterId);
    const player = rosterPlayers.find(p => p.playerId === playerId);
    if (!player) {
      throw new NotFoundException('Player not found on roster');
    }

    // Validate position can fill slot
    if (!this.canFillSlot(player.position, toSlot)) {
      throw new ValidationException(`${player.position} cannot play ${toSlot}`);
    }

    // Create new lineup
    const newLineup = this.movePlayerInLineup(currentLineup.lineup, playerId, toSlot);

    // Validate the new lineup
    const validation = this.validateLineup(newLineup, rosterPlayers, league.settings?.roster_config);
    if (!validation.valid) {
      throw new ValidationException(validation.errors.join(', '));
    }

    return this.lineupsRepo.upsert(rosterId, season, week, newLineup);
  }

  /**
   * Validate a lineup
   */
  validateLineup(
    lineup: LineupSlots,
    rosterPlayers: any[],
    rosterConfig?: any
  ): LineupValidationResult {
    const errors: string[] = [];
    const config = rosterConfig || DEFAULT_ROSTER_CONFIG;
    const rosterPlayerIds = new Set(rosterPlayers.map(p => p.playerId));
    const playerPositions = new Map(rosterPlayers.map(p => [p.playerId, p.position]));

    // Check all players in lineup are on roster
    const allLineupPlayers = [
      ...lineup.QB,
      ...lineup.RB,
      ...lineup.WR,
      ...lineup.TE,
      ...lineup.FLEX,
      ...lineup.K,
      ...lineup.DEF,
      ...lineup.BN,
    ];

    for (const playerId of allLineupPlayers) {
      if (!rosterPlayerIds.has(playerId)) {
        errors.push(`Player ${playerId} is not on roster`);
      }
    }

    // Check for duplicates
    const uniquePlayers = new Set(allLineupPlayers);
    if (uniquePlayers.size !== allLineupPlayers.length) {
      errors.push('Lineup contains duplicate players');
    }

    // Check slot limits
    if (lineup.QB.length > config.QB) {
      errors.push(`Too many QBs (max ${config.QB})`);
    }
    if (lineup.RB.length > config.RB) {
      errors.push(`Too many RBs (max ${config.RB})`);
    }
    if (lineup.WR.length > config.WR) {
      errors.push(`Too many WRs (max ${config.WR})`);
    }
    if (lineup.TE.length > config.TE) {
      errors.push(`Too many TEs (max ${config.TE})`);
    }
    if (lineup.FLEX.length > config.FLEX) {
      errors.push(`Too many FLEX (max ${config.FLEX})`);
    }
    if (lineup.K.length > config.K) {
      errors.push(`Too many Kickers (max ${config.K})`);
    }
    if (lineup.DEF.length > config.DEF) {
      errors.push(`Too many DEF (max ${config.DEF})`);
    }

    // Check position eligibility
    for (const playerId of lineup.QB) {
      if (playerPositions.get(playerId) !== 'QB') {
        errors.push(`Player ${playerId} cannot play QB`);
      }
    }
    for (const playerId of lineup.RB) {
      if (playerPositions.get(playerId) !== 'RB') {
        errors.push(`Player ${playerId} cannot play RB`);
      }
    }
    for (const playerId of lineup.WR) {
      if (playerPositions.get(playerId) !== 'WR') {
        errors.push(`Player ${playerId} cannot play WR`);
      }
    }
    for (const playerId of lineup.TE) {
      if (playerPositions.get(playerId) !== 'TE') {
        errors.push(`Player ${playerId} cannot play TE`);
      }
    }
    for (const playerId of lineup.FLEX) {
      const pos = playerPositions.get(playerId);
      if (!['RB', 'WR', 'TE'].includes(pos || '')) {
        errors.push(`Player ${playerId} cannot play FLEX`);
      }
    }
    for (const playerId of lineup.K) {
      if (playerPositions.get(playerId) !== 'K') {
        errors.push(`Player ${playerId} cannot play K`);
      }
    }
    for (const playerId of lineup.DEF) {
      if (playerPositions.get(playerId) !== 'DEF') {
        errors.push(`Player ${playerId} cannot play DEF`);
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Check if position can fill a slot
   */
  private canFillSlot(position: string | null, slot: string): boolean {
    if (!position) return false;

    switch (slot.toUpperCase()) {
      case 'QB':
        return position === 'QB';
      case 'RB':
        return position === 'RB';
      case 'WR':
        return position === 'WR';
      case 'TE':
        return position === 'TE';
      case 'FLEX':
        return ['RB', 'WR', 'TE'].includes(position);
      case 'K':
        return position === 'K';
      case 'DEF':
        return position === 'DEF';
      case 'BN':
        return true;
      default:
        return false;
    }
  }

  /**
   * Move player within lineup slots
   */
  private movePlayerInLineup(lineup: LineupSlots, playerId: number, toSlot: string): LineupSlots {
    // Remove player from current slot
    const newLineup: LineupSlots = {
      QB: lineup.QB.filter(id => id !== playerId),
      RB: lineup.RB.filter(id => id !== playerId),
      WR: lineup.WR.filter(id => id !== playerId),
      TE: lineup.TE.filter(id => id !== playerId),
      FLEX: lineup.FLEX.filter(id => id !== playerId),
      K: lineup.K.filter(id => id !== playerId),
      DEF: lineup.DEF.filter(id => id !== playerId),
      BN: lineup.BN.filter(id => id !== playerId),
    };

    // Add to new slot
    switch (toSlot.toUpperCase()) {
      case 'QB':
        newLineup.QB.push(playerId);
        break;
      case 'RB':
        newLineup.RB.push(playerId);
        break;
      case 'WR':
        newLineup.WR.push(playerId);
        break;
      case 'TE':
        newLineup.TE.push(playerId);
        break;
      case 'FLEX':
        newLineup.FLEX.push(playerId);
        break;
      case 'K':
        newLineup.K.push(playerId);
        break;
      case 'DEF':
        newLineup.DEF.push(playerId);
        break;
      case 'BN':
        newLineup.BN.push(playerId);
        break;
    }

    return newLineup;
  }

  /**
   * Lock lineups for a league/week
   */
  async lockLineups(leagueId: number, week: number, userId: string): Promise<void> {
    // Only commissioner can lock lineups
    const isCommissioner = await this.leagueRepo.isCommissioner(leagueId, userId);
    if (!isCommissioner) {
      throw new ForbiddenException('Only the commissioner can lock lineups');
    }

    const league = await this.leagueRepo.findById(leagueId);
    if (!league) {
      throw new NotFoundException('League not found');
    }

    const season = parseInt(league.season, 10);
    await this.lineupsRepo.lockLineups(leagueId, season, week);
  }

  /**
   * Lock all lineups for a week across all leagues with a specific lock time setting
   * Used by the automated lineup lock job
   * @returns number of lineups locked
   */
  async lockWeekLineupsByLockTime(
    season: number,
    week: number,
    lockTimeSetting: string
  ): Promise<number> {
    return this.lineupsRepo.lockLineupsForWeekByLockTime(season, week, lockTimeSetting);
  }
}
