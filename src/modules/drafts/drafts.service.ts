import { DraftRepository } from './drafts.repository';
import { draftToResponse } from './drafts.model';
import { LeagueRepository, RosterRepository } from '../leagues/leagues.repository';
import {
  NotFoundException,
  ForbiddenException,
} from '../../utils/exceptions';
import { DraftOrderService } from './draft-order.service';
import { DraftPickService } from './draft-pick.service';
import { DraftStateService } from './draft-state.service';
import { getSocketService } from '../../socket/socket.service';
import { logger } from '../../config/env.config';

export class DraftService {
  constructor(
    private readonly draftRepo: DraftRepository,
    private readonly leagueRepo: LeagueRepository,
    private readonly rosterRepo: RosterRepository,
    private readonly orderService: DraftOrderService,
    private readonly pickService: DraftPickService,
    private readonly stateService: DraftStateService
  ) {}

  async getLeagueDrafts(leagueId: number, userId: string): Promise<any[]> {
    const isMember = await this.leagueRepo.isUserMember(leagueId, userId);
    if (!isMember) {
      throw new ForbiddenException('You are not a member of this league');
    }

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
        nomination_seconds?: number;
        reset_on_bid_seconds?: number;
        min_bid?: number;
        min_increment?: number;
      };
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
        settings.maxActiveNominationsPerTeam = options.auctionSettings.max_active_nominations_per_team;
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

    const draft = await this.draftRepo.create(
      leagueId,
      options.draftType || 'snake',
      options.rounds || 15,
      options.pickTimeSeconds || 90,
      Object.keys(settings).length > 0 ? settings : undefined
    );

    // Create initial draft order
    await this.orderService.createInitialOrder(draft.id, leagueId);

    const response = draftToResponse(draft);

    // Emit socket event for real-time updates
    try {
      const socketService = getSocketService();
      socketService.emitDraftCreated(leagueId, response);
    } catch (socketError) {
      logger.warn(`Failed to emit draft created event: ${socketError}`);
    }

    return response;
  }

  /**
   * Get draft configuration options and defaults for a league.
   * Returns available draft types, default values, constraints, and any league-specific overrides.
   */
  async getDraftConfig(leagueId: number, userId: string): Promise<{
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

    return {
      draftTypes: [
        { value: 'snake', label: 'Snake', description: 'Pick order reverses each round' },
        { value: 'linear', label: 'Linear', description: 'Same pick order every round' },
        { value: 'auction', label: 'Auction', description: 'Bid on players with a budget' },
      ],
      defaults: {
        draftType: 'snake',
        rounds: 15,
        pickTimeSeconds: 90,
        auctionSettings: {
          bidWindowSeconds: 43200,         // 12 hours
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
}
