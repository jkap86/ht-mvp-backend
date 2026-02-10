import { Pool } from 'pg';
import { LeagueRepository, RosterRepository, CreateLeagueParams } from './leagues.repository';
import { RosterService } from './roster.service';
import { League } from './leagues.model';
import { DraftService } from '../drafts/drafts.service';
import { getDraftStructure } from '../drafts/draft-structure-presets';
import { EventListenerService } from '../chat/event-listener.service';
import { MatchupsRepository } from '../matchups/matchups.repository';
import { LeagueOperationsRepository } from './league-operations.repository';
import { NotFoundException, ForbiddenException, ValidationException } from '../../utils/exceptions';
import { runInTransaction, runWithLock } from '../../shared/transaction-runner';
import { LockDomain } from '../../shared/locks';
import { EventTypes, tryGetEventBus } from '../../shared/events';
import { logger } from '../../config/logger.config';

export class LeagueService {
  constructor(
    private readonly db: Pool,
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
    userId: string,
    idempotencyKey?: string
  ): Promise<any> {
    // Idempotency check: return existing league if same key was already used
    if (idempotencyKey) {
      const existing = await this.db.query(
        `SELECT result FROM league_operations
         WHERE idempotency_key = $1 AND user_id = $2 AND operation_type = 'create'
         AND expires_at > NOW()`,
        [idempotencyKey, userId]
      );
      if (existing.rows.length > 0) {
        return existing.rows[0].result;
      }
    }

    // Validate before starting transaction
    if (!params.name || params.name.trim().length === 0) {
      throw new ValidationException('League name is required');
    }

    if (!params.season || !/^\d{4}$/.test(params.season)) {
      throw new ValidationException('Valid season year is required (e.g., 2024)');
    }

    if (params.totalRosters < 2 || params.totalRosters > 20) {
      throw new ValidationException('Total rosters must be between 2 and 20');
    }

    // Validate draft structure before creating anything
    const structureId = params.draftStructure || 'combined';
    const leagueMode = params.mode || 'redraft';
    const structure = getDraftStructure(leagueMode, structureId);

    if (!structure) {
      throw new ValidationException('Invalid draft structure');
    }

    // Create league and commissioner roster atomically in a transaction
    const league = await runInTransaction(this.db, async (client) => {
      // Create league with client
      const league = await this.leagueRepo.createWithClient(client, {
        name: params.name.trim(),
        season: params.season,
        totalRosters: params.totalRosters,
        settings: params.settings || {},
        scoringSettings: params.scoringSettings || {},
        isPublic: params.isPublic || false,
        mode: params.mode,
        leagueSettings: params.leagueSettings,
      });

      // Create first roster for the creator (commissioner) with client
      await this.rosterService.createInitialRosterWithClient(client, league.id, userId);

      return league;
    });

    // Create drafts outside transaction (they have their own transaction logic)
    // If draft creation fails, clean up by deleting the league
    try {
      for (const preset of structure.drafts) {
        await this.draftService.createDraft(league.id, userId, {
          draftType: league.leagueSettings?.draftType || 'snake',
          pickTimeSeconds: 90,
          rounds: preset.defaultRounds,
          playerPool: preset.playerPool,
        });
      }
    } catch (error) {
      // Rollback: delete the league if draft creation fails
      logger.error(`Draft creation failed for league ${league.id}, rolling back league creation`, {
        error: error instanceof Error ? error.message : String(error),
      });
      try {
        await this.leagueRepo.delete(league.id);
      } catch (deleteError) {
        logger.error(`Failed to rollback league ${league.id}`, {
          error: deleteError instanceof Error ? deleteError.message : String(deleteError),
        });
      }
      throw error;
    }

    // Get updated league with commissioner info
    const updatedLeague = await this.leagueRepo.findByIdWithUserRoster(league.id, userId);
    const response = updatedLeague!.toResponse();

    // Store result for idempotency
    if (idempotencyKey) {
      await this.db.query(
        `INSERT INTO league_operations (idempotency_key, league_id, user_id, operation_type, result)
         VALUES ($1, $2, $3, 'create', $4)
         ON CONFLICT (idempotency_key, user_id, operation_type) DO NOTHING`,
        [idempotencyKey, league.id, userId, JSON.stringify(response)]
      );
    }

    return response;
  }

  /**
   * Check if a user is the commissioner of a league
   */
  async isCommissioner(leagueId: number, userId: string): Promise<boolean> {
    return this.leagueRepo.isCommissioner(leagueId, userId);
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

    // Get changed settings for notifications
    const changedSettings = this.getChangedSettings(currentLeague, updates);

    // Send system messages for changed settings
    if (this.eventListenerService && changedSettings.length > 0) {
      for (const settingName of changedSettings) {
        await this.eventListenerService.handleSettingsUpdated(leagueId, settingName);
      }
    }

    // Emit LEAGUE_SETTINGS_UPDATED event for real-time UI refresh
    if (changedSettings.length > 0) {
      const eventBus = tryGetEventBus();
      eventBus?.publish({
        type: EventTypes.LEAGUE_SETTINGS_UPDATED,
        leagueId,
        payload: {
          leagueId,
          changedSettings,
        },
      });
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
        rosterType: 'Roster Type',
        useLeagueMedian: 'League Median',
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

      // Bench each member and emit events (no player data to clear pre-draft)
      const eventBus = tryGetEventBus();
      for (const member of membersToBlock) {
        const teamName =
          (await this.rosterRepo.getTeamName(member.id)) || `Team ${member.rosterId}`;
        await this.rosterRepo.benchMember(member.id);

        // Emit MEMBER_BENCHED event for each benched member
        eventBus?.publish({
          type: EventTypes.MEMBER_BENCHED,
          leagueId,
          payload: {
            rosterDbId: member.id,
            rosterSlotId: member.rosterId,
            teamName,
          },
        });

        // Send system message to league chat (fire-and-forget)
        if (this.eventListenerService) {
          this.eventListenerService.handleMemberBenched(leagueId, teamName).catch((err) =>
            logger.warn('Failed to emit member benched message', {
              leagueId,
              teamName,
              error: err.message,
            })
          );
        }
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

    // Get current league state for validation
    const currentLeague = await this.leagueRepo.findById(leagueId);
    if (!currentLeague) {
      throw new NotFoundException('League not found');
    }

    // Validate week transitions - prevent backward week jumps
    if (input.currentWeek !== undefined) {
      const currentWeek = currentLeague.currentWeek || 1;
      if (input.currentWeek < currentWeek) {
        throw new ValidationException(
          `Cannot move backward from week ${currentWeek} to week ${input.currentWeek}`
        );
      }
      if (input.currentWeek < 1 || input.currentWeek > 18) {
        throw new ValidationException('Week must be between 1 and 18');
      }
    }

    // Validate season status transitions
    if (input.seasonStatus !== undefined) {
      const validStatuses = ['pre_season', 'regular_season', 'playoffs', 'offseason'];
      if (!validStatuses.includes(input.seasonStatus)) {
        throw new ValidationException(
          `Invalid season status. Must be one of: ${validStatuses.join(', ')}`
        );
      }

      // Prevent entering playoffs without a bracket
      if (input.seasonStatus === 'playoffs' && currentLeague.seasonStatus !== 'playoffs') {
        // Check if playoff bracket exists
        const season = parseInt(currentLeague.season, 10);
        // We'll add this check if playoffRepo is available
        // For now, just warn in the validation
      }

      // Validate logical status progression
      const statusOrder = { pre_season: 0, regular_season: 1, playoffs: 2, offseason: 3 };
      const currentOrder = statusOrder[currentLeague.seasonStatus as keyof typeof statusOrder] ?? 0;
      const newOrder = statusOrder[input.seasonStatus as keyof typeof statusOrder] ?? 0;

      // Allow moving to offseason from any state (for resets)
      // Otherwise, only allow forward progression or staying in same state
      if (input.seasonStatus !== 'offseason' && newOrder < currentOrder) {
        throw new ValidationException(
          `Cannot transition from ${currentLeague.seasonStatus} to ${input.seasonStatus}. ` +
          'Use league reset to go back to pre-season.'
        );
      }
    }

    const league = await this.leagueRepo.updateSeasonControls(leagueId, input);
    return league.toResponse();
  }

  async discoverPublicLeagues(userId: string, limit?: number, offset?: number): Promise<any[]> {
    return this.leagueRepo.findPublicLeagues(userId, limit, offset);
  }

  async joinPublicLeague(
    leagueId: number,
    userId: string,
    idempotencyKey?: string
  ): Promise<any> {
    const operationsRepo = new LeagueOperationsRepository(this.db);

    return await runWithLock(this.db, LockDomain.LEAGUE, leagueId, async (client) => {
      // Check idempotency first (if key provided)
      if (idempotencyKey) {
        const existing = await operationsRepo.findByKey(leagueId, userId, idempotencyKey, client);
        if (existing) {
          return existing.responseData; // Already joined
        }
      }

      // Find the league
      const league = await this.leagueRepo.findById(leagueId, client);
      if (!league) {
        throw new NotFoundException('League not found');
      }

      // Check if the league is public
      if (!league.isPublic) {
        throw new ForbiddenException('This league is private. You need an invitation to join.');
      }

      // Join the league
      await this.rosterService.joinLeague(league.id, userId, client);

      // Get updated league with roster info
      const updatedLeague = await this.leagueRepo.findByIdWithUserRoster(league.id, userId, client);
      const response = updatedLeague!.toResponse();

      // Store operation if idempotency key provided
      if (idempotencyKey) {
        await operationsRepo.create(
          leagueId,
          userId,
          'join_public_league',
          idempotencyKey,
          response,
          client
        );
      }

      return response;
    });
  }

  async resetLeagueForNewSeason(
    leagueId: number,
    userId: string,
    newSeason: string,
    options: {
      keepMembers?: boolean;
      clearChat?: boolean;
      confirmationName: string;
    },
    idempotencyKey?: string
  ): Promise<any> {
    // Idempotency check: return existing result if same key was already used
    if (idempotencyKey) {
      const existing = await this.db.query(
        `SELECT result FROM league_operations
         WHERE idempotency_key = $1 AND user_id = $2 AND operation_type = 'reset'
         AND league_id = $3 AND expires_at > NOW()`,
        [idempotencyKey, userId, leagueId]
      );
      if (existing.rows.length > 0) {
        return existing.rows[0].result;
      }
    }

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

    const response = updatedLeague.toResponse();

    // Store result for idempotency
    if (idempotencyKey) {
      await this.db.query(
        `INSERT INTO league_operations (idempotency_key, league_id, user_id, operation_type, result)
         VALUES ($1, $2, $3, 'reset', $4)
         ON CONFLICT (idempotency_key, user_id, operation_type) DO NOTHING`,
        [idempotencyKey, leagueId, userId, JSON.stringify(response)]
      );
    }

    return response;
  }
}
