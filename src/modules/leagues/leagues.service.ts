import { LeagueRepository, RosterRepository, CreateLeagueParams } from './leagues.repository';
import { RosterService } from './roster.service';
import { League } from './leagues.model';
import { DraftService } from '../drafts/drafts.service';
import { getDraftStructure } from '../drafts/draft-structure-presets';
import { EventListenerService } from '../chat/event-listener.service';
import { MatchupsRepository } from '../matchups/matchups.repository';
import { NotFoundException, ForbiddenException, ValidationException } from '../../utils/exceptions';

export class LeagueService {
  constructor(
    private readonly leagueRepo: LeagueRepository,
    private readonly rosterRepo: RosterRepository,
    private readonly rosterService: RosterService,
    private readonly draftService: DraftService,
    private readonly eventListenerService?: EventListenerService,
    private readonly matchupsRepo?: MatchupsRepository
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

  async createLeague(
    params: CreateLeagueParams & { draftStructure?: string },
    userId: string
  ): Promise<any> {
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

    // Get draft structure preset (default to 'combined')
    const structureId = params.draftStructure || 'combined';
    const leagueMode = params.mode || 'redraft';
    const structure = getDraftStructure(leagueMode, structureId);

    if (!structure) {
      throw new ValidationException('Invalid draft structure');
    }

    // Create all drafts in the structure
    for (const preset of structure.drafts) {
      await this.draftService.createDraft(league.id, userId, {
        draftType: league.leagueSettings?.draftType || 'snake',
        pickTimeSeconds: 90,
        rounds: preset.defaultRounds, // undefined uses default calculation
        playerPool: preset.playerPool,
      });
    }

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

    // Get current league state before updates to track what changed
    const currentLeague = await this.leagueRepo.findById(leagueId);
    if (!currentLeague) {
      throw new NotFoundException('League not found');
    }

    // Validate mode change restriction
    if (updates.mode !== undefined) {
      if (updates.mode !== currentLeague.mode) {
        const modeChangeCheck = await this.leagueRepo.canChangeLeagueMode(leagueId);
        if (!modeChangeCheck.allowed) {
          throw new ValidationException(modeChangeCheck.reason!);
        }
      }
    }

    // Validate rosterType lock after season starts
    if (updates.leagueSettings?.rosterType !== undefined) {
      const currentRosterType = currentLeague.leagueSettings?.rosterType;
      if (updates.leagueSettings.rosterType !== currentRosterType) {
        if (currentLeague.seasonStatus !== 'pre_season') {
          throw new ValidationException(
            'Roster type (bestball/lineup) cannot be changed after the season starts'
          );
        }
      }
    }

    // Validate league median toggle lock - cannot change after first week is finalized
    if (updates.leagueSettings?.useLeagueMedian !== undefined) {
      const currentUseMedian = currentLeague.leagueSettings?.useLeagueMedian ?? false;
      const newUseMedian = updates.leagueSettings.useLeagueMedian;

      if (newUseMedian !== currentUseMedian && this.matchupsRepo) {
        const season = parseInt(currentLeague.season, 10);
        const hasFinalized = await this.matchupsRepo.hasAnyFinalizedMatchups(leagueId, season);
        if (hasFinalized) {
          throw new ValidationException(
            'League median setting cannot be changed after the first week is finalized'
          );
        }
      }
    }

    // Handle total_rosters change with benching logic
    if (updates.totalRosters !== undefined) {
      await this.handleTotalRostersChange(leagueId, userId, updates.totalRosters);
    }

    const league = await this.leagueRepo.update(leagueId, updates);

    // Send system messages for changed settings
    if (this.eventListenerService) {
      const changedSettings = this.getChangedSettings(currentLeague, updates);
      for (const settingName of changedSettings) {
        await this.eventListenerService.handleSettingsUpdated(leagueId, settingName);
      }
    }

    return league.toResponse();
  }

  /**
   * Determines which settings have changed and returns human-readable names
   */
  private getChangedSettings(
    currentLeague: League,
    updates: Partial<League> & { totalRosters?: number }
  ): string[] {
    const changedSettings: string[] = [];

    // Map of field names to human-readable labels
    const settingLabels: Record<string, string> = {
      name: 'League Name',
      mode: 'League Mode',
      totalRosters: 'Team Count',
      isPublic: 'Privacy Setting',
      season: 'Season',
    };

    // Check simple fields
    if (updates.name !== undefined && updates.name !== currentLeague.name) {
      changedSettings.push(settingLabels.name);
    }
    if (updates.mode !== undefined && updates.mode !== currentLeague.mode) {
      changedSettings.push(settingLabels.mode);
    }
    if (updates.totalRosters !== undefined && updates.totalRosters !== currentLeague.totalRosters) {
      changedSettings.push(settingLabels.totalRosters);
    }
    if (updates.isPublic !== undefined && updates.isPublic !== currentLeague.isPublic) {
      changedSettings.push(settingLabels.isPublic);
    }
    if (updates.season !== undefined && updates.season !== currentLeague.season) {
      changedSettings.push(settingLabels.season);
    }

    // Check leagueSettings (nested object)
    if (updates.leagueSettings) {
      const currentSettings = currentLeague.leagueSettings || {};
      const leagueSettingLabels: Record<string, string> = {
        draftType: 'Draft Type',
        rosterPositions: 'Roster Positions',
        benchSlots: 'Bench Slots',
        irSlots: 'IR Slots',
        tradeDeadline: 'Trade Deadline',
        waiverType: 'Waiver Type',
        waiverDays: 'Waiver Period',
        faabBudget: 'FAAB Budget',
        playoffTeams: 'Playoff Teams',
        playoffStartWeek: 'Playoff Start Week',
        playoffRounds: 'Playoff Rounds',
      };

      for (const [key, label] of Object.entries(leagueSettingLabels)) {
        const newValue = (updates.leagueSettings as any)[key];
        const oldValue = (currentSettings as any)[key];
        if (newValue !== undefined && JSON.stringify(newValue) !== JSON.stringify(oldValue)) {
          changedSettings.push(label);
        }
      }
    }

    // Check scoringSettings (nested object)
    if (updates.scoringSettings) {
      const currentScoring = currentLeague.scoringSettings || {};
      // Check if scoring settings actually changed
      if (JSON.stringify(updates.scoringSettings) !== JSON.stringify(currentScoring)) {
        changedSettings.push('Scoring Settings');
      }
    }

    return changedSettings;
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

  async deleteLeague(leagueId: number, userId: string, confirmationName: string): Promise<void> {
    // Check if user is commissioner
    const isCommissioner = await this.leagueRepo.isCommissioner(leagueId, userId);
    if (!isCommissioner) {
      throw new ForbiddenException('Only the commissioner can delete the league');
    }

    // Get league to validate confirmation name
    const league = await this.leagueRepo.findById(leagueId);
    if (!league) {
      throw new NotFoundException('League not found');
    }

    // Validate confirmation name matches
    if (!confirmationName || confirmationName.trim().toLowerCase() !== league.name.trim().toLowerCase()) {
      throw new ValidationException('League name confirmation does not match');
    }

    await this.leagueRepo.delete(leagueId);
  }

  async updateSeasonControls(
    leagueId: number,
    userId: string,
    input: { seasonStatus?: string; currentWeek?: number }
  ): Promise<any> {
    // Check if user is commissioner
    const isCommissioner = await this.leagueRepo.isCommissioner(leagueId, userId);
    if (!isCommissioner) {
      throw new ForbiddenException('Only the commissioner can update season controls');
    }

    const league = await this.leagueRepo.updateSeasonControls(leagueId, input);
    return league.toResponse();
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
      throw new ForbiddenException('This league is private. You need an invitation to join.');
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
