import { AuctionLotRepository } from './auction-lot.repository';
import { AuctionLot, AuctionProxyBid, SlowAuctionSettings } from './auction.models';
import { DraftRepository } from '../drafts.repository';
import { Draft } from '../drafts.model';
import { RosterRepository, LeagueRepository } from '../../leagues/leagues.repository';
import { PlayerRepository } from '../../players/players.repository';
import { ValidationException, ForbiddenException, NotFoundException } from '../../../utils/exceptions';

export interface NominationResult {
  lot: AuctionLot;
  message: string;
}

export interface SetMaxBidResult {
  proxyBid: AuctionProxyBid;
  lot: AuctionLot;
  outbidNotifications: OutbidNotification[];
  message: string;
}

export interface OutbidNotification {
  rosterId: number;
  lotId: number;
  previousBid: number;
  newLeadingBid: number;
}

export interface SettlementResult {
  lot: AuctionLot;
  winner: { rosterId: number; amount: number } | null;
  passed: boolean;
}

export class SlowAuctionService {
  constructor(
    private readonly lotRepo: AuctionLotRepository,
    private readonly draftRepo: DraftRepository,
    private readonly rosterRepo: RosterRepository,
    private readonly leagueRepo: LeagueRepository,
    private readonly playerRepo: PlayerRepository
  ) {}

  // Get auction settings with defaults
  getSettings(draft: Draft): SlowAuctionSettings {
    return {
      bidWindowSeconds: draft.settings?.bidWindowSeconds ?? 43200,
      maxActiveNominationsPerTeam: draft.settings?.maxActiveNominationsPerTeam ?? 2,
      minBid: draft.settings?.minBid ?? 1,
      minIncrement: draft.settings?.minIncrement ?? 1,
    };
  }

  // Budget calculation
  async getMaxAffordableBid(
    draftId: number,
    rosterId: number,
    totalBudget: number,
    rosterSlots: number
  ): Promise<number> {
    const budgetData = await this.lotRepo.getRosterBudgetData(draftId, rosterId);
    const remainingSlots = rosterSlots - budgetData.wonCount - 1; // -1 for current
    const reservedForMinBids = Math.max(0, remainingSlots) * 1;
    return totalBudget - budgetData.spent - reservedForMinBids - budgetData.leadingCommitment;
  }

  // NOMINATE: Create a new lot for a player
  async nominate(
    draftId: number,
    rosterId: number,
    playerId: number
  ): Promise<NominationResult> {
    // 1. Validate draft exists, is auction, and in_progress
    const draft = await this.draftRepo.findById(draftId);
    if (!draft) throw new NotFoundException('Draft not found');
    if (draft.status !== 'in_progress') {
      throw new ValidationException('Draft is not in progress');
    }
    if (draft.draftType !== 'auction') {
      throw new ValidationException('This is not an auction draft');
    }

    // 2. Check nomination limit
    const settings = this.getSettings(draft);
    const activeCount = await this.lotRepo.countActiveLotsForRoster(draftId, rosterId);
    if (activeCount >= settings.maxActiveNominationsPerTeam) {
      throw new ValidationException(
        `Maximum of ${settings.maxActiveNominationsPerTeam} active nominations allowed`
      );
    }

    // 3. Check player not already nominated
    const existing = await this.lotRepo.findLotByDraftAndPlayer(draftId, playerId);
    if (existing) {
      throw new ValidationException('Player has already been nominated in this draft');
    }

    // 4. Create lot with deadline
    const bidDeadline = new Date(Date.now() + settings.bidWindowSeconds * 1000);
    const lot = await this.lotRepo.createLot(
      draftId,
      playerId,
      rosterId,
      bidDeadline,
      settings.minBid
    );

    return { lot, message: 'Player nominated successfully' };
  }

  // SET_MAX_BID: Set or update proxy bid on a lot
  async setMaxBid(
    draftId: number,
    lotId: number,
    rosterId: number,
    maxBid: number
  ): Promise<SetMaxBidResult> {
    // 1. Validate lot exists and is active
    const lot = await this.lotRepo.findLotById(lotId);
    if (!lot) throw new NotFoundException('Lot not found');
    if (lot.status !== 'active') {
      throw new ValidationException('Lot is not active');
    }
    if (lot.draftId !== draftId) {
      throw new ValidationException('Lot does not belong to this draft');
    }

    // 2. Get draft and league for settings/budget
    const draft = await this.draftRepo.findById(draftId);
    if (!draft) throw new NotFoundException('Draft not found');
    const league = await this.leagueRepo.findById(draft.leagueId);
    if (!league) throw new NotFoundException('League not found');

    const settings = this.getSettings(draft);
    const totalBudget = league.leagueSettings?.auctionBudget ?? 200;
    const rosterSlots = league.leagueSettings?.rosterSlots ?? 15;

    // 3. Validate min bid
    if (maxBid < settings.minBid) {
      throw new ValidationException(`Minimum bid is $${settings.minBid}`);
    }

    // 4. Budget validation (exclude current lot if already leading)
    const isLeadingThisLot = lot.currentBidderRosterId === rosterId;
    let maxAffordable = await this.getMaxAffordableBid(draftId, rosterId, totalBudget, rosterSlots);
    if (isLeadingThisLot) {
      maxAffordable += lot.currentBid; // Can reuse current commitment
    }
    if (maxBid > maxAffordable) {
      throw new ValidationException(`Maximum affordable bid is $${maxAffordable}`);
    }

    // 5. Upsert proxy bid
    const proxyBid = await this.lotRepo.upsertProxyBid(lotId, rosterId, maxBid);

    // 6. Resolve price
    const { updatedLot, outbidNotifications } = await this.resolvePrice(lot, settings);

    return {
      proxyBid,
      lot: updatedLot,
      outbidNotifications,
      message: 'Max bid set successfully',
    };
  }

  // Resolve price based on proxy bids (second-price auction)
  async resolvePrice(
    lot: AuctionLot,
    settings: SlowAuctionSettings
  ): Promise<{ updatedLot: AuctionLot; outbidNotifications: OutbidNotification[] }> {
    const proxyBids = await this.lotRepo.getAllProxyBidsForLot(lot.id);
    const outbidNotifications: OutbidNotification[] = [];
    let updatedLot = lot;

    if (proxyBids.length === 0) {
      return { updatedLot, outbidNotifications };
    }

    const previousLeader = lot.currentBidderRosterId;
    let newLeader: number;
    let newPrice: number;

    if (proxyBids.length === 1) {
      newLeader = proxyBids[0].rosterId;
      newPrice = settings.minBid;
    } else {
      const highest = proxyBids[0];
      const secondHighest = proxyBids[1];
      newLeader = highest.rosterId;
      newPrice = Math.min(highest.maxBid, secondHighest.maxBid + settings.minIncrement);
    }

    const leaderChanged = newLeader !== previousLeader;

    if (leaderChanged || newPrice !== lot.currentBid) {
      const updates: Partial<AuctionLot> = {
        currentBidderRosterId: newLeader,
        currentBid: newPrice,
        bidCount: lot.bidCount + 1,
      };

      // Reset timer only if leader changed
      if (leaderChanged) {
        updates.bidDeadline = new Date(Date.now() + settings.bidWindowSeconds * 1000);

        // Notify previous leader they were outbid
        if (previousLeader) {
          outbidNotifications.push({
            rosterId: previousLeader,
            lotId: lot.id,
            previousBid: lot.currentBid,
            newLeadingBid: newPrice,
          });
        }
      }

      updatedLot = await this.lotRepo.updateLot(lot.id, updates);

      // Record bid history
      await this.lotRepo.recordBidHistory(lot.id, newLeader, newPrice, true);
    }

    return { updatedLot, outbidNotifications };
  }

  // Settle an expired lot
  async settleLot(lotId: number): Promise<SettlementResult> {
    const lot = await this.lotRepo.findLotById(lotId);
    if (!lot) throw new NotFoundException('Lot not found');
    if (lot.status !== 'active') {
      throw new ValidationException('Lot is not active');
    }

    if (lot.currentBidderRosterId) {
      const settledLot = await this.lotRepo.settleLot(
        lotId,
        lot.currentBidderRosterId,
        lot.currentBid
      );
      return {
        lot: settledLot,
        winner: { rosterId: lot.currentBidderRosterId, amount: lot.currentBid },
        passed: false,
      };
    } else {
      const passedLot = await this.lotRepo.passLot(lotId);
      return {
        lot: passedLot,
        winner: null,
        passed: true,
      };
    }
  }

  // Process all expired lots (called by job)
  async processExpiredLots(): Promise<SettlementResult[]> {
    const expiredLots = await this.lotRepo.findExpiredLots();
    const results: SettlementResult[] = [];

    for (const lot of expiredLots) {
      try {
        const result = await this.settleLot(lot.id);
        results.push(result);
      } catch (error) {
        console.error(`Failed to settle lot ${lot.id}:`, error);
      }
    }

    return results;
  }
}
