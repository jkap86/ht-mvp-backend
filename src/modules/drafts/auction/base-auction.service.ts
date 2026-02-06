/**
 * Base Auction Service
 *
 * Provides shared logic for both slow and fast auction modes:
 * - Budget validation and calculation
 * - Nomination validation
 * - Settings retrieval with defaults
 * - Common queries
 */

import type { Pool, PoolClient } from 'pg';
import type { AuctionLotRepository } from './auction-lot.repository';
import type { DraftRepository } from '../drafts.repository';
import type { RosterRepository } from '../../rosters/roster.repository';
import type { LeagueRepository } from '../../leagues/leagues.repository';
import type { PlayerRepository } from '../../players/players.repository';
import type { Draft } from '../drafts.model';
import type { AuctionLot, SlowAuctionSettings } from './auction.models';
import { ValidationException, NotFoundException, ForbiddenException } from '../../../utils/exceptions';

/**
 * Common auction settings shared between slow and fast modes.
 */
export interface BaseAuctionSettings {
  auctionMode: 'slow' | 'fast';
  minBid: number;
  minIncrement: number;
  bidWindowSeconds: number;
  nominationSeconds: number;
  resetOnBidSeconds: number;
  maxActiveNominationsPerTeam: number;
  maxActiveNominationsGlobal?: number;
  dailyNominationLimit?: number;
}

/**
 * Budget information for a roster in an auction draft.
 */
export interface RosterBudgetInfo {
  rosterId: number;
  totalBudget: number;
  spent: number;
  leadingCommitment: number;
  available: number;
  wonCount: number;
  rosterSlots: number;
  username?: string;
}

/**
 * Validation result for nomination/bid operations.
 */
export interface ValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Base class providing common auction functionality.
 * Extended by FastAuctionService and SlowAuctionService.
 */
export abstract class BaseAuctionService {
  constructor(
    protected readonly lotRepo: AuctionLotRepository,
    protected readonly draftRepo: DraftRepository,
    protected readonly rosterRepo: RosterRepository,
    protected readonly leagueRepo: LeagueRepository,
    protected readonly playerRepo: PlayerRepository,
    protected readonly pool: Pool
  ) {}

  /**
   * Get auction settings from draft with defaults.
   */
  getSettings(draft: Draft): BaseAuctionSettings {
    return {
      auctionMode: draft.settings?.auctionMode ?? 'slow',
      minBid: draft.settings?.minBid ?? 1,
      minIncrement: draft.settings?.minIncrement ?? 1,
      bidWindowSeconds: draft.settings?.bidWindowSeconds ?? 43200, // 12 hours
      nominationSeconds: draft.settings?.nominationSeconds ?? 60,
      resetOnBidSeconds: draft.settings?.resetOnBidSeconds ?? 15,
      maxActiveNominationsPerTeam: draft.settings?.maxActiveNominationsPerTeam ?? 2,
      maxActiveNominationsGlobal: draft.settings?.maxActiveNominationsGlobal ?? 25,
      dailyNominationLimit: draft.settings?.dailyNominationLimit,
    };
  }

  /**
   * Get draft by ID with existence validation.
   */
  async getDraft(draftId: number): Promise<Draft> {
    const draft = await this.draftRepo.findById(draftId);
    if (!draft) {
      throw new NotFoundException('Draft not found');
    }
    return draft;
  }

  /**
   * Validate draft is an active auction draft.
   */
  validateAuctionDraft(draft: Draft): void {
    if (draft.status !== 'in_progress') {
      throw new ValidationException('Draft is not in progress');
    }
    if (draft.draftType !== 'auction') {
      throw new ValidationException('This is not an auction draft');
    }
  }

  /**
   * Validate user is a member of the league and get their roster.
   */
  async validateAndGetRoster(leagueId: number, userId: string) {
    const roster = await this.rosterRepo.findByLeagueAndUser(leagueId, userId);
    if (!roster) {
      throw new ForbiddenException('You are not a member of this league');
    }
    return roster;
  }

  /**
   * Validate player exists and is not already drafted.
   */
  async validatePlayerForNomination(draftId: number, playerId: number): Promise<void> {
    const player = await this.playerRepo.findById(playerId);
    if (!player) {
      throw new NotFoundException('Player not found');
    }

    const isDrafted = await this.draftRepo.isPlayerDrafted(draftId, playerId);
    if (isDrafted) {
      throw new ValidationException('Player has already been drafted');
    }

    const existingLot = await this.lotRepo.findLotByDraftAndPlayer(draftId, playerId);
    if (existingLot) {
      throw new ValidationException('Player has already been nominated in this draft');
    }
  }

  /**
   * Validate roster has available slots.
   */
  async validateRosterHasSlots(draftId: number, rosterId: number, rosterSlots: number): Promise<void> {
    const budgetData = await this.lotRepo.getRosterBudgetData(draftId, rosterId);
    if (budgetData.wonCount >= rosterSlots) {
      throw new ValidationException('Your roster is full');
    }
  }

  /**
   * Calculate maximum affordable bid for a roster.
   */
  calculateMaxAffordableBid(
    totalBudget: number,
    spent: number,
    leadingCommitment: number,
    wonCount: number,
    rosterSlots: number,
    minBid: number,
    currentLotBid?: number,
    isLeadingCurrentLot?: boolean
  ): number {
    const remainingSlots = rosterSlots - wonCount - 1; // -1 for current lot
    const reservedForMinBids = Math.max(0, remainingSlots) * minBid;

    let maxAffordable = totalBudget - spent - reservedForMinBids - leadingCommitment;

    // If leading current lot, can reuse that commitment
    if (isLeadingCurrentLot && currentLotBid !== undefined) {
      maxAffordable += currentLotBid;
    }

    return maxAffordable;
  }

  /**
   * Validate bid amount against budget constraints.
   */
  validateBidAmount(
    maxBid: number,
    totalBudget: number,
    spent: number,
    leadingCommitment: number,
    wonCount: number,
    rosterSlots: number,
    settings: BaseAuctionSettings,
    currentLotBid?: number,
    isLeadingCurrentLot?: boolean
  ): ValidationResult {
    // Check minimum bid
    if (maxBid < settings.minBid) {
      return { valid: false, error: `Minimum bid is $${settings.minBid}` };
    }

    const remainingSlots = rosterSlots - wonCount - 1;
    const reservedForMinBids = Math.max(0, remainingSlots) * settings.minBid;

    // Worst-case check: if you win at maxBid, can you still fill remaining roster?
    const worstCaseIfWin = maxBid + spent + remainingSlots * settings.minBid;
    if (worstCaseIfWin > totalBudget) {
      const maxSafeBid = totalBudget - spent - remainingSlots * settings.minBid;
      return {
        valid: false,
        error: `Maximum safe bid is $${Math.max(settings.minBid, maxSafeBid)} (must reserve for remaining roster)`,
      };
    }

    // Affordable check based on current commitments
    let maxAffordable = totalBudget - spent - reservedForMinBids - leadingCommitment;
    if (isLeadingCurrentLot && currentLotBid !== undefined) {
      maxAffordable += currentLotBid;
    }

    if (maxBid > maxAffordable) {
      return { valid: false, error: `Maximum affordable bid is $${maxAffordable}` };
    }

    return { valid: true };
  }

  /**
   * Get budget information for all rosters in a draft.
   */
  async getAllBudgets(draft: Draft): Promise<RosterBudgetInfo[]> {
    const league = await this.leagueRepo.findById(draft.leagueId);
    if (!league) {
      throw new NotFoundException('League not found');
    }

    const totalBudget = league.leagueSettings?.auctionBudget ?? 200;
    const rosterSlots = league.leagueSettings?.rosterSlots ?? 15;
    const settings = this.getSettings(draft);

    const rosters = await this.rosterRepo.findByLeagueId(draft.leagueId);
    const rosterIds = rosters.map((r) => r.id);

    // Batch query all budget data
    const budgetDataMap = await this.lotRepo.getAllRosterBudgetData(draft.id, rosterIds);

    return rosters.map((roster) => {
      const budgetData = budgetDataMap.get(roster.id) ?? {
        spent: 0,
        wonCount: 0,
        leadingCommitment: 0,
      };

      const remainingSlots = rosterSlots - budgetData.wonCount;
      const reservedForMinBids = Math.max(0, remainingSlots - 1) * settings.minBid;
      const available =
        totalBudget - budgetData.spent - reservedForMinBids - budgetData.leadingCommitment;

      return {
        rosterId: roster.id,
        totalBudget,
        spent: budgetData.spent,
        leadingCommitment: budgetData.leadingCommitment,
        available: Math.max(0, available),
        wonCount: budgetData.wonCount,
        rosterSlots,
        username: (roster as any).username || `Team ${roster.id}`,
      };
    });
  }

  /**
   * Get league settings for budget calculation.
   */
  async getLeagueAuctionSettings(leagueId: number): Promise<{
    totalBudget: number;
    rosterSlots: number;
  }> {
    const league = await this.leagueRepo.findById(leagueId);
    if (!league) {
      throw new NotFoundException('League not found');
    }

    return {
      totalBudget: league.leagueSettings?.auctionBudget ?? 200,
      rosterSlots: league.leagueSettings?.rosterSlots ?? 15,
    };
  }

  /**
   * Get active lots for a draft.
   */
  async getActiveLots(draftId: number): Promise<AuctionLot[]> {
    return this.lotRepo.findActiveLotsByDraft(draftId);
  }

  /**
   * Get lots by status filter.
   */
  async getLotsByStatus(draftId: number, status?: string): Promise<AuctionLot[]> {
    return this.lotRepo.findLotsByDraft(draftId, status);
  }

  /**
   * Get a single lot with draft validation.
   */
  async getLotById(draftId: number, lotId: number): Promise<AuctionLot> {
    const lot = await this.lotRepo.findLotById(lotId);
    if (!lot) {
      throw new NotFoundException('Lot not found');
    }
    if (lot.draftId !== draftId) {
      throw new NotFoundException('Lot not found in this draft');
    }
    return lot;
  }

  /**
   * Get current date string in Eastern timezone.
   * Used for daily nomination limits.
   */
  protected getEasternDateString(): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/New_York',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
  }
}
