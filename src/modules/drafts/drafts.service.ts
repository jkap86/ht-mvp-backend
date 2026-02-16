import type { PoolClient, Pool } from 'pg';
import { DraftRepository } from './drafts.repository';
import {
  draftToResponse,
  DraftType,
  DraftOrderEntry,
  DraftSettings,
  AuctionSettings,
  DraftResponse,
} from './drafts.model';
import type { LeagueRepository, RosterRepository } from '../leagues/leagues.repository';
import type { LeagueSettings } from '../leagues/leagues.model';
import type { League } from '../leagues/leagues.model';
import { NotFoundException, ForbiddenException, ValidationException } from '../../utils/exceptions';
import { DraftOrderService } from './draft-order.service';
import { DraftPickService } from './draft-pick.service';
import { DraftStateService } from './draft-state.service';
import { DraftPickAssetRepository } from './draft-pick-asset.repository';
import { DraftChessClockRepository } from './repositories/draft-chess-clock.repository';
import { EventTypes, tryGetEventBus } from '../../shared/events';
import { logger } from '../../config/logger.config';
import { container, KEYS } from '../../container';
import type { PlayerRepository } from '../players/players.repository';
import type { RosterPlayersRepository } from '../rosters/rosters.repository';
import { finalizeDraftCompletion } from './draft-completion.utils';
import { runWithLock, LockDomain } from '../../shared/transaction-runner';

/**
 * Maps auction settings from API format (snake_case) to storage format (camelCase).
 * Only includes fields that are explicitly defined (!== undefined).
 */
function mapAuctionSettingsToStorage(apiSettings: {
  auction_mode?: 'slow' | 'fast';
  bid_window_seconds?: number;
  max_active_nominations_per_team?: number;
  max_active_nominations_global?: number;
  daily_nomination_limit?: number;
  nomination_seconds?: number;
  reset_on_bid_seconds?: number;
  min_bid?: number;
  min_increment?: number;
}): Partial<AuctionSettings> {
  const mapped: Partial<AuctionSettings> = {};
  // Auction mode (slow/fast)
  if (apiSettings.auction_mode !== undefined) {
    mapped.auctionMode = apiSettings.auction_mode;
  }
  // Slow auction settings
  if (apiSettings.bid_window_seconds !== undefined) {
    mapped.bidWindowSeconds = apiSettings.bid_window_seconds;
  }
  if (apiSettings.max_active_nominations_per_team !== undefined) {
    mapped.maxActiveNominationsPerTeam = apiSettings.max_active_nominations_per_team;
  }
  if (apiSettings.max_active_nominations_global !== undefined) {
    mapped.maxActiveNominationsGlobal = apiSettings.max_active_nominations_global;
  }
  if (apiSettings.daily_nomination_limit !== undefined) {
    mapped.dailyNominationLimit = apiSettings.daily_nomination_limit;
  }
  // Fast auction settings
  if (apiSettings.nomination_seconds !== undefined) {
    mapped.nominationSeconds = apiSettings.nomination_seconds;
  }
  if (apiSettings.reset_on_bid_seconds !== undefined) {
    mapped.resetOnBidSeconds = apiSettings.reset_on_bid_seconds;
  }
  // Shared settings
  if (apiSettings.min_bid !== undefined) {
    mapped.minBid = apiSettings.min_bid;
  }
  if (apiSettings.min_increment !== undefined) {
    mapped.minIncrement = apiSettings.min_increment;
  }
  return mapped;
}

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

  private calculateTotalRosterSlots(
    leagueSettings: LeagueSettings | Record<string, unknown> | undefined
  ): number {
    const rosterConfig = (leagueSettings as Record<string, unknown>)?.roster_config as
      | Record<string, number>
      | undefined;
    if (!rosterConfig) return 15; // fallback default

    return Object.values(rosterConfig).reduce(
      (sum: number, val: unknown) => sum + (typeof val === 'number' ? val : 0),
      0
    );
  }

  async getLeagueDrafts(leagueId: number, userId: string, leagueSeasonId?: number): Promise<any[]> {
    // Use atomic query that checks membership while fetching drafts to avoid race condition
    const drafts = await this.draftRepo.findByLeagueIdWithMembershipCheck(
      leagueId,
      userId,
      leagueSeasonId
    );

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

    const response = draftToResponse(draft);

    // Include chess clocks if in chess clock mode and draft is active
    const settings = draft.settings as DraftSettings;
    if (settings?.timerMode === 'chess_clock' && draft.status !== 'not_started') {
      const chessClockRepo = container.resolve<DraftChessClockRepository>(KEYS.CHESS_CLOCK_REPO);
      response.chess_clocks = await chessClockRepo.getClockMap(draftId);
    }

    return response;
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
      leagueSeasonId?: number;
      timerMode?: 'per_pick' | 'chess_clock';
      chessClockTotalSeconds?: number;
      chessClockMinPickSeconds?: number;
    }
  ): Promise<any> {
    const isCommissioner = await this.leagueRepo.isCommissioner(leagueId, userId);
    if (!isCommissioner) {
      throw new ForbiddenException('Only the commissioner can create drafts');
    }

    // Transform auction settings from snake_case (API) to camelCase (storage)
    const settings: DraftSettings = {};
    if (options.auctionSettings) {
      Object.assign(settings, mapAuctionSettingsToStorage(options.auctionSettings));
    }

    // Add player pool setting (defaults handled by schema)
    if (options.playerPool) {
      settings.playerPool = options.playerPool;
    }

    // Add rookie picks settings for vet-only drafts
    if (options.includeRookiePicks !== undefined) {
      // Validate includeRookiePicks is only enabled for veteran-only drafts
      if (options.includeRookiePicks === true) {
        const effectivePlayerPool = options.playerPool || ['veteran', 'rookie'];
        const hasRookies = effectivePlayerPool.includes('rookie');
        if (hasRookies) {
          throw new ValidationException(
            'includeRookiePicks can only be enabled for veteran-only drafts (playerPool must not include rookies)'
          );
        }
      }
      settings.includeRookiePicks = options.includeRookiePicks;
    }
    if (options.rookiePicksSeason !== undefined) {
      settings.rookiePicksSeason = options.rookiePicksSeason;
    }
    if (options.rookiePicksRounds !== undefined) {
      settings.rookiePicksRounds = options.rookiePicksRounds;
    }

    // Chess clock settings (only for snake/linear)
    if (options.timerMode) {
      if (options.timerMode === 'chess_clock' && options.draftType === 'auction') {
        throw new ValidationException('Chess clock mode is not supported for auction drafts');
      }
      settings.timerMode = options.timerMode;
    }
    if (options.chessClockTotalSeconds !== undefined) {
      settings.chessClockTotalSeconds = options.chessClockTotalSeconds;
    }
    if (options.chessClockMinPickSeconds !== undefined) {
      settings.chessClockMinPickSeconds = options.chessClockMinPickSeconds;
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

    // Wrap entire draft creation in a lock to ensure atomicity of draft + order + pick assets
    const pool = container.resolve<Pool>(KEYS.POOL);
    const response = await runWithLock(pool, LockDomain.LEAGUE, leagueId, async (client) => {
      const draft = await this.draftRepo.createWithClient(
        client,
        leagueId,
        options.draftType || 'snake',
        options.rounds || defaultRounds,
        options.pickTimeSeconds || 90,
        Object.keys(settings).length > 0 ? settings : undefined,
        options.scheduledStart,
        options.leagueSeasonId
      );

      // Create initial draft order within the transaction
      await this.orderService.createInitialOrderWithClient(
        client,
        draft.id,
        leagueId,
        league?.totalRosters || 2
      );

      // Handle draft pick assets
      if (this.pickAssetRepo && league) {
        const season = parseInt(league.season, 10);
        const rounds = options.rounds || defaultRounds;

        // Check if this is a rookie draft with existing pick assets (from vet draft)
        const isRookieDraft =
          settings.playerPool?.length === 1 && settings.playerPool[0] === 'rookie';
        const pickAssetsExist = await this.pickAssetRepo.existsForLeagueSeason(leagueId, season, client);

        if (isRookieDraft && pickAssetsExist) {
          // Link existing pick assets to this rookie draft instead of generating new ones
          await this.pickAssetRepo.linkAssetsToDraft(leagueId, season, draft.id, client);

          // Update pick positions based on current draft order
          await this.pickAssetRepo.updatePickPositions(draft.id, client);

          logger.info(
            `Linked existing pick assets to rookie draft ${draft.id} for season ${season}. ` +
              `Commissioner can use "Set Order from Vet Draft" or randomize.`
          );
        } else {
          // Standard flow: generate new pick assets
          // Get draft order to extract positions
          const draftOrder = await this.draftRepo.getDraftOrderWithClient(client, draft.id);
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
            orderData,
            client
          );

          // For dynasty and devy leagues, also generate future pick assets
          if (league.mode === 'dynasty' || league.mode === 'devy') {
            for (let futureYear = season + 1; futureYear <= season + 3; futureYear++) {
              await this.pickAssetRepo.generateFuturePickAssets(
                leagueId,
                futureYear,
                rounds,
                orderData,
                client
              );
            }
            logger.info(
              `Generated future pick assets for ${league.mode} league ${leagueId} (seasons ${season + 1}-${season + 3})`
            );
          }

          logger.info(`Generated ${rosterIds.length * rounds} pick assets for draft ${draft.id}`);
        }
      }

      return draftToResponse(draft);
    });

    // Emit event for real-time updates AFTER transaction commits
    const eventBus = tryGetEventBus();
    eventBus?.publish({
      type: EventTypes.DRAFT_CREATED,
      leagueId,
      payload: { leagueId, draft: response },
    });

    return response;
  }

  /**
   * Create a draft within an existing transaction.
   * Used during league creation to keep draft creation atomic with league creation.
   * Skips commissioner check since this is called internally during league setup.
   *
   * Events are NOT emitted here; the caller should emit events after the transaction commits.
   */
  async createDraftWithClient(
    client: PoolClient,
    league: League,
    options: {
      draftType?: string;
      rounds?: number;
      pickTimeSeconds?: number;
      playerPool?: ('veteran' | 'rookie' | 'college')[];
      scheduledStart?: Date;
      leagueSeasonId?: number;
    }
  ): Promise<any> {
    const leagueId = league.id;
    const settings: DraftSettings = {};

    if (options.playerPool) {
      settings.playerPool = options.playerPool;
    }

    const defaultRounds = this.calculateTotalRosterSlots(league.leagueSettings || league.settings);

    const draft = await this.draftRepo.createWithClient(
      client,
      leagueId,
      options.draftType || 'snake',
      options.rounds || defaultRounds,
      options.pickTimeSeconds || 90,
      Object.keys(settings).length > 0 ? settings : undefined,
      options.scheduledStart,
      options.leagueSeasonId
    );

    // Create initial draft order within the transaction
    await this.orderService.createInitialOrderWithClient(
      client,
      draft.id,
      leagueId,
      league.totalRosters
    );

    // Handle draft pick assets
    if (this.pickAssetRepo) {
      const season = parseInt(league.season, 10);
      const rounds = options.rounds || defaultRounds;

      // Get draft order to extract positions
      const draftOrder = await this.draftRepo.getDraftOrderWithClient(client, draft.id);
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
        orderData,
        client
      );

      // For dynasty and devy leagues, also generate future pick assets
      if (league.mode === 'dynasty' || league.mode === 'devy') {
        for (let futureYear = season + 1; futureYear <= season + 3; futureYear++) {
          await this.pickAssetRepo.generateFuturePickAssets(
            leagueId,
            futureYear,
            rounds,
            orderData,
            client
          );
        }
        logger.info(
          `Generated future pick assets for ${league.mode} league ${leagueId} (seasons ${season + 1}-${season + 3})`
        );
      }

      logger.info(`Generated ${rosterIds.length * rounds} pick assets for draft ${draft.id}`);
    }

    return draftToResponse(draft);
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

  async randomizeDraftOrder(
    leagueId: number,
    draftId: number,
    userId: string,
    idempotencyKey?: string
  ): Promise<any[]> {
    return this.orderService.randomizeDraftOrder(leagueId, draftId, userId, idempotencyKey);
  }

  async confirmDraftOrder(
    leagueId: number,
    draftId: number,
    userId: string,
    idempotencyKey?: string
  ): Promise<any[]> {
    return this.orderService.confirmDraftOrder(leagueId, draftId, userId, idempotencyKey);
  }

  async setOrderFromPickOwnership(
    leagueId: number,
    draftId: number,
    userId: string
  ): Promise<any[]> {
    return this.orderService.setOrderFromPickOwnership(leagueId, draftId, userId);
  }

  // Delegate to state service
  async startDraft(draftId: number, userId: string, idempotencyKey?: string): Promise<any> {
    return this.stateService.startDraft(draftId, userId, idempotencyKey);
  }

  async pauseDraft(draftId: number, userId: string, idempotencyKey?: string): Promise<any> {
    return this.stateService.pauseDraft(draftId, userId, idempotencyKey);
  }

  async resumeDraft(draftId: number, userId: string, idempotencyKey?: string): Promise<any> {
    return this.stateService.resumeDraft(draftId, userId, idempotencyKey);
  }

  async completeDraft(draftId: number, userId: string, idempotencyKey?: string): Promise<any> {
    return this.stateService.completeDraft(draftId, userId, idempotencyKey);
  }

  async deleteDraft(leagueId: number, draftId: number, userId: string): Promise<void> {
    return this.stateService.deleteDraft(leagueId, draftId, userId);
  }

  async undoPick(
    leagueId: number,
    draftId: number,
    userId: string
  ): Promise<{ draft: any; undone: any }> {
    return this.stateService.undoPick(leagueId, draftId, userId);
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

    // Emit event
    const eventBus = tryGetEventBus();
    eventBus?.publish({
      type: EventTypes.DRAFT_AUTODRAFT_TOGGLED,
      payload: {
        draftId,
        rosterId: roster.id,
        enabled,
        forced: false,
      },
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
      overnightPauseEnabled?: boolean;
      overnightPauseStart?: string;
      overnightPauseEnd?: string;
      timerMode?: 'per_pick' | 'chess_clock';
      chessClockTotalSeconds?: number;
      chessClockMinPickSeconds?: number;
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

    // 3a. Validate overnight pause settings
    if (updates.overnightPauseEnabled || updates.overnightPauseStart || updates.overnightPauseEnd) {
      // Validate overnight pause is only for snake/linear drafts
      const draftType = updates.draftType || draft.draftType;
      if (draftType === 'auction') {
        throw new ValidationException('Overnight pause is not supported for auction drafts');
      }

      // Validate time format (HH:MM)
      const timeRegex = /^([01]?\d|2[0-3]):([0-5]\d)$/;
      if (updates.overnightPauseStart && !timeRegex.test(updates.overnightPauseStart)) {
        throw new ValidationException('overnight_pause_start must be in HH:MM format');
      }
      if (updates.overnightPauseEnd && !timeRegex.test(updates.overnightPauseEnd)) {
        throw new ValidationException('overnight_pause_end must be in HH:MM format');
      }

      // If enabling overnight pause, ensure both start and end times are provided
      if (updates.overnightPauseEnabled === true) {
        const startTime = updates.overnightPauseStart || draft.overnightPauseStart;
        const endTime = updates.overnightPauseEnd || draft.overnightPauseEnd;
        if (!startTime || !endTime) {
          throw new ValidationException(
            'Both overnight_pause_start and overnight_pause_end must be provided when enabling overnight pause'
          );
        }
      }
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
    const mergedSettings: DraftSettings = { ...existingSettings };

    if (updates.auctionSettings) {
      Object.assign(mergedSettings, mapAuctionSettingsToStorage(updates.auctionSettings));
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
      // Validate includeRookiePicks is only enabled for veteran-only drafts
      if (updates.includeRookiePicks === true) {
        const effectivePlayerPool = updates.playerPool ||
          mergedSettings.playerPool || ['veteran', 'rookie'];
        const hasRookies = effectivePlayerPool.includes('rookie');
        if (hasRookies) {
          throw new ValidationException(
            'includeRookiePicks can only be enabled for veteran-only drafts (playerPool must not include rookies)'
          );
        }
      }
      mergedSettings.includeRookiePicks = updates.includeRookiePicks;
    }
    if (updates.rookiePicksSeason !== undefined) {
      mergedSettings.rookiePicksSeason = updates.rookiePicksSeason;
    }
    if (updates.rookiePicksRounds !== undefined) {
      mergedSettings.rookiePicksRounds = updates.rookiePicksRounds;
    }

    // Handle chess clock settings
    if (updates.timerMode !== undefined) {
      // Prevent changing timer mode after draft starts
      if (draft.status !== 'not_started') {
        throw new ValidationException('Cannot change timer mode after draft has started');
      }
      const effectiveDraftType = updates.draftType || draft.draftType;
      if (updates.timerMode === 'chess_clock' && effectiveDraftType === 'auction') {
        throw new ValidationException('Chess clock mode is not supported for auction drafts');
      }
      mergedSettings.timerMode = updates.timerMode;
    }
    if (updates.chessClockTotalSeconds !== undefined) {
      mergedSettings.chessClockTotalSeconds = updates.chessClockTotalSeconds;
    }
    if (updates.chessClockMinPickSeconds !== undefined) {
      mergedSettings.chessClockMinPickSeconds = updates.chessClockMinPickSeconds;
    }

    // 6. Perform the update
    // Cast draftType to DraftType since schema validation already ensures it's valid
    const updatedDraft = await this.draftRepo.update(draftId, {
      draftType: updates.draftType as DraftType | undefined,
      rounds: updates.rounds,
      pickTimeSeconds: updates.pickTimeSeconds,
      settings: Object.keys(mergedSettings).length > 0 ? mergedSettings : undefined,
      scheduledStart: updates.scheduledStart,
      overnightPauseEnabled: updates.overnightPauseEnabled,
      overnightPauseStart: updates.overnightPauseStart,
      overnightPauseEnd: updates.overnightPauseEnd,
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
        await this.pickAssetRepo.generateFuturePickAssets(leagueId, season, rounds, orderData);

        logger.info(
          `Generated ${orderData.length * rounds} rookie pick assets for vet draft ${draftId}, ` +
            `season ${season}, ${rounds} rounds`
        );
      }
    }

    const response = draftToResponse(updatedDraft);

    // 9. Emit event for real-time updates
    const eventBus = tryGetEventBus();
    eventBus?.publish({
      type: EventTypes.DRAFT_SETTINGS_UPDATED,
      payload: { draftId, draft: response },
    });

    logger.info(`Commissioner ${userId} updated settings for draft ${draftId}`);

    return response;
  }

  /**
   * Get available matchup options for the current picker in a matchups draft.
   * Only valid when draft is in progress and is a matchups type.
   */
  async getAvailableMatchups(leagueId: number, draftId: number, userId: string) {
    // Verify user is a league member
    const isMember = await this.leagueRepo.isUserMember(leagueId, userId);
    if (!isMember) {
      throw new ForbiddenException('You are not a member of this league');
    }

    const draft = await this.draftRepo.findById(draftId);
    if (!draft) {
      throw new NotFoundException('Draft not found');
    }

    if (draft.leagueId !== leagueId) {
      throw new ForbiddenException('Draft does not belong to this league');
    }

    if (draft.draftType !== 'matchups') {
      throw new ValidationException('This is not a matchups draft');
    }

    if (draft.status !== 'in_progress') {
      throw new ValidationException('Draft is not in progress');
    }

    // Get the engine for this draft
    const pool = container.resolve<Pool>(KEYS.POOL);
    const playerRepo = container.resolve<PlayerRepository>(KEYS.PLAYER_REPO);
    const rosterPlayersRepo = container.resolve<RosterPlayersRepository>(KEYS.ROSTER_PLAYERS_REPO);
    const { MatchupsDraftEngine } = await import('../../engines/matchups-draft.engine');
    const engine = new MatchupsDraftEngine(
      this.draftRepo,
      playerRepo,
      rosterPlayersRepo,
      this.leagueRepo,
      this.rosterRepo
    );

    // Get draft order
    const draftOrder = await this.draftRepo.getDraftOrder(draftId);

    // Get available matchups using the engine (within a readonly transaction for consistency)
    const { withClient } = await import('../../shared/transaction-runner');
    const matchups = await withClient(pool, async (client) => {
      return await engine.getAvailableMatchups(client, draft, draftOrder);
    });

    // Convert to response format
    return matchups.map((m) => ({
      week: m.week,
      opponent_roster_id: m.opponentRosterId,
      opponent_team_name: m.opponentTeamName,
      current_frequency: m.currentFrequency,
      max_frequency: m.maxFrequency,
    }));
  }

  /**
   * Make a matchup pick in a matchups draft.
   * Creates reciprocal matchup entries for both teams.
   */
  async makeMatchupPick(
    leagueId: number,
    draftId: number,
    userId: string,
    week: number,
    opponentRosterId: number
  ): Promise<{
    pick_id: number;
    reciprocal_pick_id: number;
    week: number;
    roster_id: number;
    opponent_roster_id: number;
    picked_at: Date;
    draft: DraftResponse;
  }> {
    // Verify user is a league member
    const isMember = await this.leagueRepo.isUserMember(leagueId, userId);
    if (!isMember) {
      throw new ForbiddenException('You are not a member of this league');
    }

    const draft = await this.draftRepo.findById(draftId);
    if (!draft) {
      throw new NotFoundException('Draft not found');
    }

    if (draft.leagueId !== leagueId) {
      throw new ForbiddenException('Draft does not belong to this league');
    }

    if (draft.draftType !== 'matchups') {
      throw new ValidationException('This is not a matchups draft');
    }

    if (draft.status !== 'in_progress') {
      throw new ValidationException('Draft is not in progress');
    }

    // Get user's roster
    const userRoster = await this.rosterRepo.findByLeagueAndUser(leagueId, userId);
    if (!userRoster) {
      throw new ForbiddenException('You are not a member of this league');
    }

    // Verify it's this roster's turn to pick
    if (draft.currentRosterId !== userRoster.id) {
      throw new ForbiddenException('It is not your turn to pick');
    }

    // Get the engine
    const playerRepo = container.resolve<PlayerRepository>(KEYS.PLAYER_REPO);
    const rosterPlayersRepo = container.resolve<RosterPlayersRepository>(KEYS.ROSTER_PLAYERS_REPO);
    const { MatchupsDraftEngine } = await import('../../engines/matchups-draft.engine');
    const engine = new MatchupsDraftEngine(
      this.draftRepo,
      playerRepo,
      rosterPlayersRepo,
      this.leagueRepo,
      this.rosterRepo
    );

    // Get draft order
    const draftOrder = await this.draftRepo.getDraftOrder(draftId);
    const totalRosters = draftOrder.length;

    // Compute next pick state
    const currentPickNumber = draft.currentPick;
    const pickInRound = ((currentPickNumber - 1) % totalRosters) + 1;
    const round = Math.ceil(currentPickNumber / totalRosters);

    // Import MatchupDraftRepository directly
    const { MatchupDraftRepository } = await import('./repositories/matchup-draft.repository');
    const pool = container.resolve<Pool>(KEYS.POOL);
    const matchupDraftRepo = new MatchupDraftRepository(pool);

    // Validate and compute next state within a transaction
    const { runInDraftTransaction } = await import('../../shared/locks');
    const pickResult = await runInDraftTransaction(pool, draftId, async (client) => {
      // Validate the matchup selection
      await engine.validateMatchupSelection(
        client,
        draft,
        draftOrder,
        userRoster.id,
        week,
        opponentRosterId
      );

      // Compute next pick state
      const { computeNextPickState } = await import('./draft-pick-state.utils');
      const nextPickState = computeNextPickState(draft, draftOrder, engine, []);

      // Make the pick atomically
      const result = await matchupDraftRepo.makeMatchupPickAndAdvanceTxWithClient(client, {
        draftId,
        expectedPickNumber: currentPickNumber,
        round,
        pickInRound,
        rosterId: userRoster.id,
        week,
        opponentRosterId,
        nextPickState,
        idempotencyKey: `matchup-pick-${draftId}-${currentPickNumber}`,
        isAutoPick: false,
      });

      // Handle draft completion inside the transaction (while DRAFT lock is held)
      if (result.draft.status === 'completed') {
        const rosterPlayersRepo = container.resolve<RosterPlayersRepository>(
          KEYS.ROSTER_PLAYERS_REPO
        );
        await finalizeDraftCompletion(
          {
            draftRepo: this.draftRepo,
            leagueRepo: this.leagueRepo,
            rosterPlayersRepo,
          },
          draftId,
          leagueId,
          client
        );
      }

      return result;
    });

    // Emit socket events
    const eventBus = tryGetEventBus();
    eventBus?.publish({
      type: EventTypes.DRAFT_PICK,
      payload: {
        draft_id: draftId,
        pick_id: pickResult.result.pickId,
        week: pickResult.result.week,
        roster_id: userRoster.id,
        opponent_roster_id: opponentRosterId,
        is_auto_pick: false,
        picked_at: pickResult.result.pickedAt,
      },
    });

    if (pickResult.draft.status === 'completed') {
      eventBus?.publish({
        type: EventTypes.DRAFT_COMPLETED,
        payload: draftToResponse(pickResult.draft) as unknown as Record<string, unknown>,
      });
    } else {
      // Emit next pick event
      eventBus?.publish({
        type: EventTypes.DRAFT_NEXT_PICK,
        payload: {
          draftId,
          currentPick: pickResult.draft.currentPick,
          currentRound: pickResult.draft.currentRound,
          currentRosterId: pickResult.draft.currentRosterId,
          pickDeadline: pickResult.draft.pickDeadline,
          status: 'in_progress',
        },
      });
    }

    return {
      pick_id: pickResult.result.pickId,
      reciprocal_pick_id: pickResult.result.reciprocalPickId,
      week: pickResult.result.week,
      roster_id: userRoster.id,
      opponent_roster_id: opponentRosterId,
      picked_at: pickResult.result.pickedAt,
      draft: draftToResponse(pickResult.draft),
    };
  }
}
