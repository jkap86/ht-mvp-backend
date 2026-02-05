import { DraftRepository } from './drafts.repository';
import { draftToResponse, DraftType, DraftOrderEntry } from './drafts.model';
import { LeagueRepository, RosterRepository } from '../leagues/leagues.repository';
import { NotFoundException, ForbiddenException, ValidationException } from '../../utils/exceptions';
import { DraftOrderService } from './draft-order.service';
import { DraftPickService } from './draft-pick.service';
import { DraftStateService } from './draft-state.service';
import { DraftPickAssetRepository } from './draft-pick-asset.repository';
import { tryGetSocketService } from '../../socket/socket.service';
import { logger } from '../../config/env.config';

export class DraftService {
  constructor(
    private readonly draftRepo: DraftRepository,
    private readonly leagueRepo: LeagueRepository,
    private readonly rosterRepo: RosterRepository,
    private readonly orderService: DraftOrderService,
    private readonly pickService: DraftPickService,
    private readonly stateService: DraftStateService,
    private readonly pickAssetRepo?: DraftPickAssetRepository
  ) {}

  private calculateTotalRosterSlots(leagueSettings: any): number {
    const rosterConfig = leagueSettings?.roster_config;
    if (!rosterConfig) return 15; // fallback default

    return (
      (rosterConfig.QB || 0) +
      (rosterConfig.RB || 0) +
      (rosterConfig.WR || 0) +
      (rosterConfig.TE || 0) +
      (rosterConfig.FLEX || 0) +
      (rosterConfig.K || 0) +
      (rosterConfig.DEF || 0) +
      (rosterConfig.BN || 0)
    );
  }

  async getLeagueDrafts(leagueId: number, userId: string): Promise<any[]> {
    // Use atomic query that checks membership while fetching drafts to avoid race condition
    const drafts = await this.draftRepo.findByLeagueIdWithMembershipCheck(leagueId, userId);

    // findByLeagueIdWithMembershipCheck returns null if user is not a member
    if (drafts === null) {
      throw new ForbiddenException('You are not a member of this league');
    }

    return drafts.map(draftToResponse);
  }

  /**
   * Get drafts by league ID without membership check (for internal service use only)
   */
  async getDraftsByLeague(leagueId: number): Promise<any[]> {
    const drafts = await this.draftRepo.findByLeagueId(leagueId);
    return drafts.map(draftToResponse);
  }

  async getDraftById(leagueId: number, draftId: number, userId: string): Promise<any> {
    const isMember = await this.leagueRepo.isUserMember(leagueId, userId);
    if (!isMember) {
      throw new ForbiddenException('You are not a member of this league');
    }

    const draft = await this.draftRepo.findById(draftId);
    if (!draft || draft.leagueId !== leagueId) {
      throw new NotFoundException('Draft not found');
    }

    return draftToResponse(draft);
  }

  async createDraft(
    leagueId: number,
    userId: string,
    options: {
      draftType?: string;
      rounds?: number;
      pickTimeSeconds?: number;
      auctionSettings?: {
        auction_mode?: 'slow' | 'fast';
        bid_window_seconds?: number;
        max_active_nominations_per_team?: number;
        max_active_nominations_global?: number;
        daily_nomination_limit?: number;
        nomination_seconds?: number;
        reset_on_bid_seconds?: number;
        min_bid?: number;
        min_increment?: number;
      };
      playerPool?: ('veteran' | 'rookie' | 'college')[];
      scheduledStart?: Date;
      includeRookiePicks?: boolean;
      rookiePicksSeason?: number;
      rookiePicksRounds?: number;
    }
  ): Promise<any> {
    const isCommissioner = await this.leagueRepo.isCommissioner(leagueId, userId);
    if (!isCommissioner) {
      throw new ForbiddenException('Only the commissioner can create drafts');
    }

    // Transform auction settings from snake_case (API) to camelCase (storage)
    const settings: Record<string, any> = {};
    if (options.auctionSettings) {
      // Auction mode (slow/fast)
      if (options.auctionSettings.auction_mode !== undefined) {
        settings.auctionMode = options.auctionSettings.auction_mode;
      }
      // Slow auction settings
      if (options.auctionSettings.bid_window_seconds !== undefined) {
        settings.bidWindowSeconds = options.auctionSettings.bid_window_seconds;
      }
      if (options.auctionSettings.max_active_nominations_per_team !== undefined) {
        settings.maxActiveNominationsPerTeam =
          options.auctionSettings.max_active_nominations_per_team;
      }
      // Fast auction settings
      if (options.auctionSettings.nomination_seconds !== undefined) {
        settings.nominationSeconds = options.auctionSettings.nomination_seconds;
      }
      if (options.auctionSettings.reset_on_bid_seconds !== undefined) {
        settings.resetOnBidSeconds = options.auctionSettings.reset_on_bid_seconds;
      }
      // Shared settings
      if (options.auctionSettings.min_bid !== undefined) {
        settings.minBid = options.auctionSettings.min_bid;
      }
      if (options.auctionSettings.min_increment !== undefined) {
        settings.minIncrement = options.auctionSettings.min_increment;
      }
    }

    // Add player pool setting (defaults handled by schema)
    if (options.playerPool) {
      settings.playerPool = options.playerPool;
    }

    // Add rookie picks settings for vet-only drafts
    if (options.includeRookiePicks !== undefined) {
      settings.includeRookiePicks = options.includeRookiePicks;
    }
    if (options.rookiePicksSeason !== undefined) {
      settings.rookiePicksSeason = options.rookiePicksSeason;
    }
    if (options.rookiePicksRounds !== undefined) {
      settings.rookiePicksRounds = options.rookiePicksRounds;
    }

    // Get league for validation and roster config
    const league = await this.leagueRepo.findById(leagueId);

    // Validate college player pool only allowed for devy leagues
    if (options.playerPool?.includes('college') && league?.mode !== 'devy') {
      throw new ValidationException('College players can only be included in Devy leagues');
    }

    const defaultRounds = this.calculateTotalRosterSlots(
      league?.leagueSettings || league?.settings
    );

    const draft = await this.draftRepo.create(
      leagueId,
      options.draftType || 'snake',
      options.rounds || defaultRounds,
      options.pickTimeSeconds || 90,
      Object.keys(settings).length > 0 ? settings : undefined,
      options.scheduledStart
    );

    // Create initial draft order
    await this.orderService.createInitialOrder(draft.id, leagueId);

    // Handle draft pick assets
    if (this.pickAssetRepo && league) {
      const season = parseInt(league.season, 10);
      const rounds = options.rounds || defaultRounds;

      // Check if this is a rookie draft with existing pick assets (from vet draft)
      const isRookieDraft =
        settings.playerPool?.length === 1 && settings.playerPool[0] === 'rookie';
      const pickAssetsExist = await this.pickAssetRepo.existsForLeagueSeason(leagueId, season);

      if (isRookieDraft && pickAssetsExist) {
        // Link existing pick assets to this rookie draft instead of generating new ones
        await this.pickAssetRepo.linkAssetsToDraft(leagueId, season, draft.id);

        // Update pick positions based on current draft order
        await this.pickAssetRepo.updatePickPositions(draft.id);

        logger.info(
          `Linked existing pick assets to rookie draft ${draft.id} for season ${season}. ` +
            `Commissioner can use "Set Order from Vet Draft" or randomize.`
        );
      } else {
        // Standard flow: generate new pick assets
        // Get draft order to extract positions
        const draftOrder = await this.draftRepo.getDraftOrder(draft.id);
        const orderData = draftOrder.map((entry: DraftOrderEntry) => ({
          rosterId: entry.rosterId,
          draftPosition: entry.draftPosition,
        }));
        const rosterIds = orderData.map((entry) => entry.rosterId);

        // Generate pick assets for this draft
        await this.pickAssetRepo.generatePickAssetsForDraft(
          draft.id,
          leagueId,
          season,
          rounds,
          orderData
        );

        // For dynasty and devy leagues, also generate future pick assets
        if (league.mode === 'dynasty' || league.mode === 'devy') {
          for (let futureYear = season + 1; futureYear <= season + 3; futureYear++) {
            await this.pickAssetRepo.generateFuturePickAssets(
              leagueId,
              futureYear,
              rounds,
              orderData
            );
          }
          logger.info(
            `Generated future pick assets for ${league.mode} league ${leagueId} (seasons ${season + 1}-${season + 3})`
          );
        }

        logger.info(`Generated ${rosterIds.length * rounds} pick assets for draft ${draft.id}`);
      }
    }

    const response = draftToResponse(draft);

    // Emit socket event for real-time updates
    const socketService = tryGetSocketService();
    socketService?.emitDraftCreated(leagueId, response);

    return response;
  }

  /**
   * Get draft configuration options and defaults for a league.
   * Returns available draft types, default values, constraints, and any league-specific overrides.
   */
  async getDraftConfig(
    leagueId: number,
    userId: string
  ): Promise<{
    draftTypes: Array<{ value: string; label: string; description: string }>;
    defaults: {
      draftType: string;
      rounds: number;
      pickTimeSeconds: number;
      auctionSettings: {
        bidWindowSeconds: number;
        maxActiveNominationsPerTeam: number;
        minBid: number;
        minIncrement: number;
        budget: number;
      };
    };
    constraints: {
      rounds: { min: number; max: number };
      pickTimeSeconds: { min: number; max: number };
      bidWindowSeconds: { min: number; max: number };
      maxActiveNominationsPerTeam: { min: number; max: number };
      budget: { min: number; max: number };
    };
    leagueOverrides: {
      auctionBudget?: number;
      rosterSlots?: number;
    };
  }> {
    // Verify user is a member of the league
    const isMember = await this.leagueRepo.isUserMember(leagueId, userId);
    if (!isMember) {
      throw new ForbiddenException('You are not a member of this league');
    }

    // Get league settings for overrides
    const league = await this.leagueRepo.findById(leagueId);
    const leagueSettings = league?.leagueSettings || {};
    const totalRosterSlots = this.calculateTotalRosterSlots(leagueSettings);

    return {
      draftTypes: [
        { value: 'snake', label: 'Snake', description: 'Pick order reverses each round' },
        { value: 'linear', label: 'Linear', description: 'Same pick order every round' },
        { value: 'auction', label: 'Auction', description: 'Bid on players with a budget' },
      ],
      defaults: {
        draftType: 'snake',
        rounds: totalRosterSlots,
        pickTimeSeconds: 90,
        auctionSettings: {
          bidWindowSeconds: 43200, // 12 hours
          maxActiveNominationsPerTeam: 2,
          minBid: 1,
          minIncrement: 1,
          budget: leagueSettings.auctionBudget ?? 200,
        },
      },
      constraints: {
        rounds: { min: 1, max: 30 },
        pickTimeSeconds: { min: 30, max: 600 },
        bidWindowSeconds: { min: 3600, max: 172800 },
        maxActiveNominationsPerTeam: { min: 1, max: 10 },
        budget: { min: 1, max: 10000 },
      },
      leagueOverrides: {
        auctionBudget: leagueSettings.auctionBudget,
        rosterSlots: leagueSettings.rosterSlots,
      },
    };
  }

  // Delegate to order service
  async getDraftOrder(leagueId: number, draftId: number, userId: string): Promise<any[]> {
    return this.orderService.getDraftOrder(leagueId, draftId, userId);
  }

  async randomizeDraftOrder(leagueId: number, draftId: number, userId: string): Promise<any[]> {
    return this.orderService.randomizeDraftOrder(leagueId, draftId, userId);
  }

  async confirmDraftOrder(leagueId: number, draftId: number, userId: string): Promise<any[]> {
    return this.orderService.confirmDraftOrder(leagueId, draftId, userId);
  }

  async setOrderFromPickOwnership(
    leagueId: number,
    draftId: number,
    userId: string
  ): Promise<any[]> {
    return this.orderService.setOrderFromPickOwnership(leagueId, draftId, userId);
  }

  // Delegate to state service
  async startDraft(draftId: number, userId: string): Promise<any> {
    return this.stateService.startDraft(draftId, userId);
  }

  async pauseDraft(draftId: number, userId: string): Promise<any> {
    return this.stateService.pauseDraft(draftId, userId);
  }

  async resumeDraft(draftId: number, userId: string): Promise<any> {
    return this.stateService.resumeDraft(draftId, userId);
  }

  async completeDraft(draftId: number, userId: string): Promise<any> {
    return this.stateService.completeDraft(draftId, userId);
  }

  async deleteDraft(leagueId: number, draftId: number, userId: string): Promise<void> {
    return this.stateService.deleteDraft(leagueId, draftId, userId);
  }

  async undoPick(draftId: number, userId: string): Promise<{ draft: any; undone: any }> {
    return this.stateService.undoPick(draftId, userId);
  }

  // Delegate to pick service
  async getDraftPicks(leagueId: number, draftId: number, userId: string): Promise<any[]> {
    return this.pickService.getDraftPicks(leagueId, draftId, userId);
  }

  async makePick(
    leagueId: number,
    draftId: number,
    userId: string,
    playerId: number,
    idempotencyKey?: string
  ): Promise<any> {
    return this.pickService.makePick(leagueId, draftId, userId, playerId, idempotencyKey);
  }

  async getAvailablePickAssets(leagueId: number, draftId: number, userId: string): Promise<any[]> {
    return this.pickService.getAvailablePickAssets(leagueId, draftId, userId);
  }

  async makePickAssetSelection(
    leagueId: number,
    draftId: number,
    userId: string,
    draftPickAssetId: number,
    idempotencyKey?: string
  ): Promise<any> {
    return this.pickService.makePickAssetSelection(
      leagueId,
      draftId,
      userId,
      draftPickAssetId,
      idempotencyKey
    );
  }

  /**
   * Toggle autodraft for the current user in a draft.
   * When enabled, the system will automatically pick from the user's queue when their timer expires.
   */
  async toggleAutodraft(
    leagueId: number,
    draftId: number,
    userId: string,
    enabled: boolean
  ): Promise<{ rosterId: number; enabled: boolean }> {
    // Verify membership
    const isMember = await this.leagueRepo.isUserMember(leagueId, userId);
    if (!isMember) {
      throw new ForbiddenException('You are not a member of this league');
    }

    // Verify draft exists and belongs to league
    const draft = await this.draftRepo.findById(draftId);
    if (!draft || draft.leagueId !== leagueId) {
      throw new NotFoundException('Draft not found');
    }

    // Get user's roster
    const roster = await this.rosterRepo.findByLeagueAndUser(leagueId, userId);
    if (!roster) {
      throw new ForbiddenException('You are not in this league');
    }

    // Update autodraft setting
    await this.draftRepo.setAutodraftEnabled(draftId, roster.id, enabled);

    // Emit socket event
    const socketService = tryGetSocketService();
    socketService?.emitAutodraftToggled(draftId, {
      rosterId: roster.id,
      enabled,
      forced: false,
    });

    logger.info(`User ${userId} toggled autodraft to ${enabled} for draft ${draftId}`);

    return { rosterId: roster.id, enabled };
  }

  /**
   * Update draft settings (commissioner only).
   * Can update all settings before draft starts, or only timer-related settings while paused.
   */
  async updateDraftSettings(
    leagueId: number,
    draftId: number,
    userId: string,
    updates: {
      draftType?: string;
      rounds?: number;
      pickTimeSeconds?: number;
      auctionSettings?: {
        auction_mode?: 'slow' | 'fast';
        bid_window_seconds?: number;
        max_active_nominations_per_team?: number;
        max_active_nominations_global?: number;
        daily_nomination_limit?: number;
        nomination_seconds?: number;
        reset_on_bid_seconds?: number;
        min_bid?: number;
        min_increment?: number;
      };
      playerPool?: ('veteran' | 'rookie' | 'college')[];
      scheduledStart?: Date | null;
      includeRookiePicks?: boolean;
      rookiePicksSeason?: number;
      rookiePicksRounds?: number;
    }
  ): Promise<any> {
    // 1. Verify commissioner
    const isCommissioner = await this.leagueRepo.isCommissioner(leagueId, userId);
    if (!isCommissioner) {
      throw new ForbiddenException('Only the commissioner can update draft settings');
    }

    // 2. Get draft and validate it belongs to league
    const draft = await this.draftRepo.findById(draftId);
    if (!draft || draft.leagueId !== leagueId) {
      throw new NotFoundException('Draft not found');
    }

    // 3. Check what can be edited based on status
    if (draft.status === 'completed') {
      throw new ValidationException('Cannot edit completed draft settings');
    }
    if (draft.status === 'in_progress') {
      throw new ValidationException(
        'Cannot edit draft settings while in progress. Pause the draft first.'
      );
    }

    // 4. If paused, only allow timer-related changes
    const hasStructuralChanges =
      updates.draftType !== undefined ||
      updates.rounds !== undefined ||
      updates.auctionSettings?.auction_mode !== undefined ||
      updates.auctionSettings?.max_active_nominations_per_team !== undefined ||
      updates.auctionSettings?.min_bid !== undefined;

    if (draft.status === 'paused' && hasStructuralChanges) {
      throw new ValidationException(
        'Cannot change draft type, rounds, or auction mode while paused. Only timer settings can be changed.'
      );
    }

    // 5. Transform and merge auction settings
    const existingSettings = draft.settings || {};
    const mergedSettings: Record<string, any> = { ...existingSettings };

    if (updates.auctionSettings) {
      if (updates.auctionSettings.auction_mode !== undefined) {
        mergedSettings.auctionMode = updates.auctionSettings.auction_mode;
      }
      if (updates.auctionSettings.bid_window_seconds !== undefined) {
        mergedSettings.bidWindowSeconds = updates.auctionSettings.bid_window_seconds;
      }
      if (updates.auctionSettings.max_active_nominations_per_team !== undefined) {
        mergedSettings.maxActiveNominationsPerTeam =
          updates.auctionSettings.max_active_nominations_per_team;
      }
      if (updates.auctionSettings.nomination_seconds !== undefined) {
        mergedSettings.nominationSeconds = updates.auctionSettings.nomination_seconds;
      }
      if (updates.auctionSettings.reset_on_bid_seconds !== undefined) {
        mergedSettings.resetOnBidSeconds = updates.auctionSettings.reset_on_bid_seconds;
      }
      if (updates.auctionSettings.min_bid !== undefined) {
        mergedSettings.minBid = updates.auctionSettings.min_bid;
      }
      if (updates.auctionSettings.min_increment !== undefined) {
        mergedSettings.minIncrement = updates.auctionSettings.min_increment;
      }
      if (updates.auctionSettings.max_active_nominations_global !== undefined) {
        mergedSettings.maxActiveNominationsGlobal =
          updates.auctionSettings.max_active_nominations_global;
      }
      if (updates.auctionSettings.daily_nomination_limit !== undefined) {
        mergedSettings.dailyNominationLimit =
          updates.auctionSettings.daily_nomination_limit;
      }
    }

    // Handle player pool setting
    if (updates.playerPool) {
      // Validate college player pool only allowed for devy leagues
      const league = await this.leagueRepo.findById(leagueId);
      if (updates.playerPool.includes('college') && league?.mode !== 'devy') {
        throw new ValidationException('College players can only be included in Devy leagues');
      }
      mergedSettings.playerPool = updates.playerPool;
    }

    // Handle rookie picks settings
    if (updates.includeRookiePicks !== undefined) {
      mergedSettings.includeRookiePicks = updates.includeRookiePicks;
    }
    if (updates.rookiePicksSeason !== undefined) {
      mergedSettings.rookiePicksSeason = updates.rookiePicksSeason;
    }
    if (updates.rookiePicksRounds !== undefined) {
      mergedSettings.rookiePicksRounds = updates.rookiePicksRounds;
    }

    // 6. Perform the update
    // Cast draftType to DraftType since schema validation already ensures it's valid
    const updatedDraft = await this.draftRepo.update(draftId, {
      draftType: updates.draftType as DraftType | undefined,
      rounds: updates.rounds,
      pickTimeSeconds: updates.pickTimeSeconds,
      settings: Object.keys(mergedSettings).length > 0 ? mergedSettings : undefined,
      scheduledStart: updates.scheduledStart,
    });

    // 7. If rounds changed and draft not started, regenerate pick assets
    if (
      updates.rounds &&
      updates.rounds !== draft.rounds &&
      draft.status === 'not_started' &&
      this.pickAssetRepo
    ) {
      const league = await this.leagueRepo.findById(leagueId);
      if (league) {
        const season = parseInt(league.season, 10);

        // Get draft order to extract positions
        const draftOrder = await this.draftRepo.getDraftOrder(draftId);
        const orderData = draftOrder.map((entry: DraftOrderEntry) => ({
          rosterId: entry.rosterId,
          draftPosition: entry.draftPosition,
        }));

        // Delete existing pick assets for this draft
        await this.pickAssetRepo.deleteByDraftId(draftId);

        // Regenerate with new round count
        await this.pickAssetRepo.generatePickAssetsForDraft(
          draftId,
          leagueId,
          season,
          updates.rounds,
          orderData
        );

        logger.info(`Regenerated pick assets for draft ${draftId} with ${updates.rounds} rounds`);
      }
    }

    // 8. Generate rookie pick assets if includeRookiePicks is enabled
    if (
      mergedSettings.includeRookiePicks === true &&
      mergedSettings.rookiePicksSeason &&
      draft.status === 'not_started' &&
      this.pickAssetRepo
    ) {
      const season = mergedSettings.rookiePicksSeason;
      const rounds = mergedSettings.rookiePicksRounds || 5; // Default 5 rounds

      // Get all active rosters in the league for future picks
      // NOTE: We use all active rosters (not the vet draft's order) because future
      // rookie picks should exist for every team, regardless of vet draft participation
      const rosters = await this.rosterRepo.findByLeagueId(leagueId);
      const activeRosters = rosters.filter((r) => !r.isBenched);
      const orderData = activeRosters.map((r, index) => ({
        rosterId: r.id,
        draftPosition: index + 1,
      }));

      // Check if picks already exist for this season
      const existingPicks = await this.pickAssetRepo.findByLeagueAndSeason(leagueId, season);

      // Calculate expected pick count
      const expectedPickCount = orderData.length * rounds;

      // Check if we need to regenerate (wrong count or no picks)
      if (existingPicks.length !== expectedPickCount) {
        // Delete existing picks for this season that don't have a draft_id
        // (future picks, not picks already linked to a draft)
        await this.pickAssetRepo.deleteUnlinkedPicksForSeason(leagueId, season);

        // Generate future pick assets with correct round count
        await this.pickAssetRepo.generateFuturePickAssets(
          leagueId,
          season,
          rounds,
          orderData
        );

        logger.info(
          `Generated ${orderData.length * rounds} rookie pick assets for vet draft ${draftId}, ` +
            `season ${season}, ${rounds} rounds`
        );
      }
    }

    const response = draftToResponse(updatedDraft);

    // 9. Emit socket event for real-time updates
    const socketService = tryGetSocketService();
    socketService?.emitDraftSettingsUpdated(draftId, response);

    logger.info(`Commissioner ${userId} updated settings for draft ${draftId}`);

    return response;
  }
}
