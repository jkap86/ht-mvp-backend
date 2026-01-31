import { Pool } from 'pg';
import { LineupsRepository } from './lineups.repository';
import { RosterPlayersRepository } from '../rosters/rosters.repository';
import { LeagueRepository, RosterRepository } from '../leagues/leagues.repository';
import {
  RosterLineup,
  LineupSlots,
  LineupValidationResult,
  DEFAULT_ROSTER_CONFIG,
} from './lineups.model';
import { NotFoundException, ForbiddenException, ValidationException } from '../../utils/exceptions';

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

    // Validate roster exists - use findByLeagueAndRosterId since URL contains per-league roster_id
    const roster = await this.rosterRepo.findByLeagueAndRosterId(leagueId, rosterId);
    if (!roster) {
      throw new NotFoundException('Roster not found');
    }

    // Use the global id for all subsequent operations
    const globalRosterId = roster.id;

    const league = await this.leagueRepo.findById(leagueId);
    if (!league) {
      throw new NotFoundException('League not found');
    }

    const season = parseInt(league.season, 10);

    // Try to get existing lineup
    let lineup = await this.lineupsRepo.findByRosterAndWeek(globalRosterId, season, week);

    // If doesn't exist, create default
    if (!lineup) {
      const defaultLineup: LineupSlots = {
        QB: [],
        RB: [],
        WR: [],
        TE: [],
        FLEX: [],
        SUPER_FLEX: [],
        REC_FLEX: [],
        K: [],
        DEF: [],
        DL: [],
        LB: [],
        DB: [],
        IDP_FLEX: [],
        BN: [],
        IR: [],
        TAXI: [],
      };

      // Put all roster players on bench initially
      const rosterPlayers = await this.rosterPlayersRepo.getByRosterId(globalRosterId);
      defaultLineup.BN = rosterPlayers.map((p) => p.playerId);

      lineup = await this.lineupsRepo.upsert(globalRosterId, season, week, defaultLineup);
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
    // Validate user owns this roster - use findByLeagueAndRosterId since URL contains per-league roster_id
    const roster = await this.rosterRepo.findByLeagueAndRosterId(leagueId, rosterId);
    if (!roster) {
      throw new NotFoundException('Roster not found');
    }

    if (roster.userId !== userId) {
      throw new ForbiddenException('You can only manage your own lineup');
    }

    // Use the global id for all subsequent operations
    const globalRosterId = roster.id;

    const league = await this.leagueRepo.findById(leagueId);
    if (!league) {
      throw new NotFoundException('League not found');
    }

    const season = parseInt(league.season, 10);

    // Check if lineup is locked
    const isLocked = await this.lineupsRepo.isLocked(globalRosterId, season, week);
    if (isLocked) {
      throw new ValidationException('Lineup is locked and cannot be modified');
    }

    // Validate lineup
    const rosterPlayers = await this.rosterPlayersRepo.getByRosterId(globalRosterId);
    const validation = this.validateLineup(lineup, rosterPlayers, league.settings?.roster_config);

    if (!validation.valid) {
      throw new ValidationException(validation.errors.join(', '));
    }

    return this.lineupsRepo.upsert(globalRosterId, season, week, lineup);
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
    // Get current lineup (this also validates roster exists via findByLeagueAndRosterId)
    const currentLineup = await this.getLineup(leagueId, rosterId, week, userId);

    // Validate user owns this roster - use findByLeagueAndRosterId since URL contains per-league roster_id
    const roster = await this.rosterRepo.findByLeagueAndRosterId(leagueId, rosterId);
    if (!roster || roster.userId !== userId) {
      throw new ForbiddenException('You can only manage your own lineup');
    }

    // Use the global id for all subsequent operations
    const globalRosterId = roster.id;

    const league = await this.leagueRepo.findById(leagueId);
    if (!league) {
      throw new NotFoundException('League not found');
    }

    const season = parseInt(league.season, 10);

    // Check if lineup is locked
    const isLocked = await this.lineupsRepo.isLocked(globalRosterId, season, week);
    if (isLocked) {
      throw new ValidationException('Lineup is locked and cannot be modified');
    }

    // Get player position
    const rosterPlayers = await this.rosterPlayersRepo.getByRosterId(globalRosterId);
    const player = rosterPlayers.find((p) => p.playerId === playerId);
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
    const validation = this.validateLineup(
      newLineup,
      rosterPlayers,
      league.settings?.roster_config
    );
    if (!validation.valid) {
      throw new ValidationException(validation.errors.join(', '));
    }

    return this.lineupsRepo.upsert(globalRosterId, season, week, newLineup);
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
    // Merge with defaults - for new slots, 0 means none configured
    const passedConfig = rosterConfig || {};
    const config = {
      QB: passedConfig.QB ?? DEFAULT_ROSTER_CONFIG.QB,
      RB: passedConfig.RB ?? DEFAULT_ROSTER_CONFIG.RB,
      WR: passedConfig.WR ?? DEFAULT_ROSTER_CONFIG.WR,
      TE: passedConfig.TE ?? DEFAULT_ROSTER_CONFIG.TE,
      FLEX: passedConfig.FLEX ?? DEFAULT_ROSTER_CONFIG.FLEX,
      SUPER_FLEX: passedConfig.SUPER_FLEX ?? DEFAULT_ROSTER_CONFIG.SUPER_FLEX,
      REC_FLEX: passedConfig.REC_FLEX ?? DEFAULT_ROSTER_CONFIG.REC_FLEX,
      K: passedConfig.K ?? DEFAULT_ROSTER_CONFIG.K,
      DEF: passedConfig.DEF ?? DEFAULT_ROSTER_CONFIG.DEF,
      DL: passedConfig.DL ?? DEFAULT_ROSTER_CONFIG.DL,
      LB: passedConfig.LB ?? DEFAULT_ROSTER_CONFIG.LB,
      DB: passedConfig.DB ?? DEFAULT_ROSTER_CONFIG.DB,
      IDP_FLEX: passedConfig.IDP_FLEX ?? DEFAULT_ROSTER_CONFIG.IDP_FLEX,
      BN: passedConfig.BN ?? DEFAULT_ROSTER_CONFIG.BN,
      IR: passedConfig.IR ?? DEFAULT_ROSTER_CONFIG.IR,
      TAXI: passedConfig.TAXI ?? DEFAULT_ROSTER_CONFIG.TAXI,
    };
    const rosterPlayerIds = new Set(rosterPlayers.map((p) => p.playerId));
    const playerPositions = new Map(rosterPlayers.map((p) => [p.playerId, p.position]));

    // Check all players in lineup are on roster
    const allLineupPlayers = [
      ...lineup.QB,
      ...lineup.RB,
      ...lineup.WR,
      ...lineup.TE,
      ...lineup.FLEX,
      ...lineup.SUPER_FLEX,
      ...lineup.REC_FLEX,
      ...lineup.K,
      ...lineup.DEF,
      ...lineup.DL,
      ...lineup.LB,
      ...lineup.DB,
      ...lineup.IDP_FLEX,
      ...lineup.BN,
      ...lineup.IR,
      ...lineup.TAXI,
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
    if (lineup.SUPER_FLEX.length > config.SUPER_FLEX) {
      errors.push(`Too many SUPER_FLEX (max ${config.SUPER_FLEX})`);
    }
    if (lineup.REC_FLEX.length > config.REC_FLEX) {
      errors.push(`Too many REC_FLEX (max ${config.REC_FLEX})`);
    }
    if (lineup.K.length > config.K) {
      errors.push(`Too many Kickers (max ${config.K})`);
    }
    if (lineup.DEF.length > config.DEF) {
      errors.push(`Too many DEF (max ${config.DEF})`);
    }
    if (lineup.DL.length > config.DL) {
      errors.push(`Too many DL (max ${config.DL})`);
    }
    if (lineup.LB.length > config.LB) {
      errors.push(`Too many LB (max ${config.LB})`);
    }
    if (lineup.DB.length > config.DB) {
      errors.push(`Too many DB (max ${config.DB})`);
    }
    if (lineup.IDP_FLEX.length > config.IDP_FLEX) {
      errors.push(`Too many IDP_FLEX (max ${config.IDP_FLEX})`);
    }
    if (lineup.IR.length > config.IR) {
      errors.push(`Too many IR (max ${config.IR})`);
    }
    if (lineup.TAXI.length > config.TAXI) {
      errors.push(`Too many TAXI (max ${config.TAXI})`);
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
    for (const playerId of lineup.SUPER_FLEX) {
      const pos = playerPositions.get(playerId);
      if (!['QB', 'RB', 'WR', 'TE'].includes(pos || '')) {
        errors.push(`Player ${playerId} cannot play SUPER_FLEX`);
      }
    }
    for (const playerId of lineup.REC_FLEX) {
      const pos = playerPositions.get(playerId);
      if (!['WR', 'TE'].includes(pos || '')) {
        errors.push(`Player ${playerId} cannot play REC_FLEX`);
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
    for (const playerId of lineup.DL) {
      if (playerPositions.get(playerId) !== 'DL') {
        errors.push(`Player ${playerId} cannot play DL`);
      }
    }
    for (const playerId of lineup.LB) {
      if (playerPositions.get(playerId) !== 'LB') {
        errors.push(`Player ${playerId} cannot play LB`);
      }
    }
    for (const playerId of lineup.DB) {
      if (playerPositions.get(playerId) !== 'DB') {
        errors.push(`Player ${playerId} cannot play DB`);
      }
    }
    for (const playerId of lineup.IDP_FLEX) {
      const pos = playerPositions.get(playerId);
      if (!['DL', 'LB', 'DB'].includes(pos || '')) {
        errors.push(`Player ${playerId} cannot play IDP_FLEX`);
      }
    }
    // IR and TAXI can hold any player (eligibility checked elsewhere)
    // BN can hold any player

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
      case 'SUPER_FLEX':
        return ['QB', 'RB', 'WR', 'TE'].includes(position);
      case 'REC_FLEX':
        return ['WR', 'TE'].includes(position);
      case 'K':
        return position === 'K';
      case 'DEF':
        return position === 'DEF';
      case 'DL':
        return position === 'DL';
      case 'LB':
        return position === 'LB';
      case 'DB':
        return position === 'DB';
      case 'IDP_FLEX':
        return ['DL', 'LB', 'DB'].includes(position);
      case 'BN':
      case 'IR':
      case 'TAXI':
        return true; // Any player can go here
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
      QB: lineup.QB.filter((id) => id !== playerId),
      RB: lineup.RB.filter((id) => id !== playerId),
      WR: lineup.WR.filter((id) => id !== playerId),
      TE: lineup.TE.filter((id) => id !== playerId),
      FLEX: lineup.FLEX.filter((id) => id !== playerId),
      SUPER_FLEX: lineup.SUPER_FLEX.filter((id) => id !== playerId),
      REC_FLEX: lineup.REC_FLEX.filter((id) => id !== playerId),
      K: lineup.K.filter((id) => id !== playerId),
      DEF: lineup.DEF.filter((id) => id !== playerId),
      DL: lineup.DL.filter((id) => id !== playerId),
      LB: lineup.LB.filter((id) => id !== playerId),
      DB: lineup.DB.filter((id) => id !== playerId),
      IDP_FLEX: lineup.IDP_FLEX.filter((id) => id !== playerId),
      BN: lineup.BN.filter((id) => id !== playerId),
      IR: lineup.IR.filter((id) => id !== playerId),
      TAXI: lineup.TAXI.filter((id) => id !== playerId),
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
      case 'SUPER_FLEX':
        newLineup.SUPER_FLEX.push(playerId);
        break;
      case 'REC_FLEX':
        newLineup.REC_FLEX.push(playerId);
        break;
      case 'K':
        newLineup.K.push(playerId);
        break;
      case 'DEF':
        newLineup.DEF.push(playerId);
        break;
      case 'DL':
        newLineup.DL.push(playerId);
        break;
      case 'LB':
        newLineup.LB.push(playerId);
        break;
      case 'DB':
        newLineup.DB.push(playerId);
        break;
      case 'IDP_FLEX':
        newLineup.IDP_FLEX.push(playerId);
        break;
      case 'BN':
        newLineup.BN.push(playerId);
        break;
      case 'IR':
        newLineup.IR.push(playerId);
        break;
      case 'TAXI':
        newLineup.TAXI.push(playerId);
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
