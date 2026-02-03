import { LeagueRepository, RosterRepository, CreateLeagueParams } from './leagues.repository';
import { RosterService } from './roster.service';
import { League } from './leagues.model';
import { DraftService } from '../drafts/drafts.service';
import { NotFoundException, ForbiddenException, ValidationException } from '../../utils/exceptions';

export class LeagueService {
  constructor(
    private readonly leagueRepo: LeagueRepository,
    private readonly rosterRepo: RosterRepository,
    private readonly rosterService: RosterService,
    private readonly draftService: DraftService
  ) {}

  async getUserLeagues(userId: string, limit?: number, offset?: number): Promise<any[]> {
    const leagues = await this.leagueRepo.findByUserId(userId, limit, offset);
    return leagues.map((l) => l.toResponse());
  }

  async getLeagueById(leagueId: number, userId: string): Promise<any> {
    const league = await this.leagueRepo.findByIdWithUserRoster(leagueId, userId);

    if (!league) {
      throw new NotFoundException('League not found');
    }

    // Check membership using the roster data we already fetched (no separate query)
    // This prevents race conditions when a user has just joined the league
    if (!league.userRosterId) {
      throw new ForbiddenException('You are not a member of this league');
    }

    // Check if league mode can be changed
    const modeCheck = await this.leagueRepo.canChangeLeagueMode(leagueId);

    return league.toResponse({ canChangeMode: modeCheck.allowed });
  }

  async createLeague(params: CreateLeagueParams, userId: string): Promise<any> {
    // Validate
    if (!params.name || params.name.trim().length === 0) {
      throw new ValidationException('League name is required');
    }

    if (!params.season || !/^\d{4}$/.test(params.season)) {
      throw new ValidationException('Valid season year is required (e.g., 2024)');
    }

    if (params.totalRosters < 2 || params.totalRosters > 20) {
      throw new ValidationException('Total rosters must be between 2 and 20');
    }

    // Create league
    const league = await this.leagueRepo.create({
      name: params.name.trim(),
      season: params.season,
      totalRosters: params.totalRosters,
      settings: params.settings || {},
      scoringSettings: params.scoringSettings || {},
      isPublic: params.isPublic || false,
      mode: params.mode,
      leagueSettings: params.leagueSettings,
    });

    // Create first roster for the creator (commissioner) via RosterService
    await this.rosterService.createInitialRoster(league.id, userId);

    // Auto-create draft for all league types
    await this.draftService.createDraft(league.id, userId, {
      draftType: league.leagueSettings?.draftType || 'snake',
      // rounds will default to roster_config total via calculateTotalRosterSlots()
      pickTimeSeconds: 90,
    });

    // Get updated league with commissioner info
    const updatedLeague = await this.leagueRepo.findByIdWithUserRoster(league.id, userId);
    return updatedLeague!.toResponse();
  }

  async updateLeague(
    leagueId: number,
    userId: string,
    updates: Partial<League> & { totalRosters?: number }
  ): Promise<any> {
    // Check if user is commissioner
    const isCommissioner = await this.leagueRepo.isCommissioner(leagueId, userId);
    if (!isCommissioner) {
      throw new ForbiddenException('Only the commissioner can update league settings');
    }

    // Validate mode change restriction
    if (updates.mode !== undefined) {
      const currentLeague = await this.leagueRepo.findById(leagueId);
      if (currentLeague && updates.mode !== currentLeague.mode) {
        const modeChangeCheck = await this.leagueRepo.canChangeLeagueMode(leagueId);
        if (!modeChangeCheck.allowed) {
          throw new ValidationException(modeChangeCheck.reason!);
        }
      }
    }

    // Handle total_rosters change with benching logic
    if (updates.totalRosters !== undefined) {
      await this.handleTotalRostersChange(leagueId, userId, updates.totalRosters);
    }

    const league = await this.leagueRepo.update(leagueId, updates);
    return league.toResponse();
  }

  /**
   * Handle changes to total_rosters, benching excess members if necessary
   */
  private async handleTotalRostersChange(
    leagueId: number,
    userId: string,
    newTotalRosters: number
  ): Promise<void> {
    // Validate the new value
    if (newTotalRosters < 2 || newTotalRosters > 20) {
      throw new ValidationException('Total rosters must be between 2 and 20');
    }

    // Only allow team count changes when league is pre_draft
    const league = await this.leagueRepo.findById(leagueId);
    if (!league) {
      throw new NotFoundException('League not found');
    }
    if (league.status !== 'pre_draft') {
      throw new ValidationException('Team count can only be changed before the draft');
    }

    // Get current active member count
    const currentActiveCount = await this.rosterRepo.getRosterCount(leagueId);

    // If reducing below current active count, bench excess members
    if (newTotalRosters < currentActiveCount) {
      const excessCount = currentActiveCount - newTotalRosters;

      // Get commissioner's roster ID to exclude from benching
      const commissionerRoster = await this.rosterRepo.findByLeagueAndUser(leagueId, userId);
      if (!commissionerRoster) {
        throw new ValidationException('Commissioner roster not found');
      }

      // Get newest members to bench (excluding commissioner)
      const membersToBlock = await this.rosterRepo.getNewestMembers(
        leagueId,
        excessCount,
        commissionerRoster.rosterId
      );

      // Bench each member (no player data to clear pre-draft)
      for (const member of membersToBlock) {
        await this.rosterRepo.benchMember(member.id);
      }
    }
  }

  async deleteLeague(leagueId: number, userId: string): Promise<void> {
    // Check if user is commissioner
    const isCommissioner = await this.leagueRepo.isCommissioner(leagueId, userId);
    if (!isCommissioner) {
      throw new ForbiddenException('Only the commissioner can delete the league');
    }

    await this.leagueRepo.delete(leagueId);
  }

  async joinLeagueByInviteCode(inviteCode: string, userId: string): Promise<any> {
    // Find league by invite code
    const league = await this.leagueRepo.findByInviteCode(inviteCode);
    if (!league) {
      throw new NotFoundException('Invalid invite code');
    }

    // Join the league
    await this.rosterService.joinLeague(league.id, userId);

    // Return the league with user's roster info
    const updatedLeague = await this.leagueRepo.findByIdWithUserRoster(league.id, userId);
    return updatedLeague!.toResponse();
  }

  async discoverPublicLeagues(userId: string, limit?: number, offset?: number): Promise<any[]> {
    return this.leagueRepo.findPublicLeagues(userId, limit, offset);
  }

  async joinPublicLeague(leagueId: number, userId: string): Promise<any> {
    // Find the league first
    const league = await this.leagueRepo.findById(leagueId);
    if (!league) {
      throw new NotFoundException('League not found');
    }

    // Check if the league is public
    if (!league.isPublic) {
      throw new ForbiddenException('This league is private. Use an invite code to join.');
    }

    // Join the league
    await this.rosterService.joinLeague(league.id, userId);

    // Return the league with user's roster info
    const updatedLeague = await this.leagueRepo.findByIdWithUserRoster(league.id, userId);
    return updatedLeague!.toResponse();
  }

  async resetLeagueForNewSeason(
    leagueId: number,
    userId: string,
    newSeason: string,
    options: {
      keepMembers?: boolean;
      clearChat?: boolean;
      confirmationName: string;
    }
  ): Promise<any> {
    // Verify commissioner
    const isCommissioner = await this.leagueRepo.isCommissioner(leagueId, userId);
    if (!isCommissioner) {
      throw new ForbiddenException('Only the commissioner can reset the league');
    }

    // Get league and validate
    const league = await this.leagueRepo.findById(leagueId);
    if (!league) {
      throw new NotFoundException('League not found');
    }

    // Validate season status
    if (league.seasonStatus !== 'offseason' && league.seasonStatus !== 'pre_season') {
      throw new ValidationException(
        'League can only be reset during pre-season or offseason. Current status: ' +
          league.seasonStatus
      );
    }

    // Validate confirmation name
    if (options.confirmationName.trim().toLowerCase() !== league.name.trim().toLowerCase()) {
      throw new ValidationException('League name confirmation does not match');
    }

    // Validate new season format
    if (!/^\d{4}$/.test(newSeason)) {
      throw new ValidationException('Season must be a 4-digit year');
    }

    // Perform reset
    const updatedLeague = await this.leagueRepo.resetForNewSeason(leagueId, newSeason, {
      keepMembers: options.keepMembers,
      clearChat: options.clearChat,
    });

    return updatedLeague.toResponse();
  }
}
