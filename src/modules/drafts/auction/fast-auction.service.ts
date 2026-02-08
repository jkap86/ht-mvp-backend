import { Pool, PoolClient } from 'pg';
import { AuctionLotRepository } from './auction-lot.repository';
import { DraftRepository } from '../drafts.repository';
import { RosterRepository, LeagueRepository } from '../../leagues/leagues.repository';
import { DraftOrderService } from '../draft-order.service';
import { EventTypes, tryGetEventBus } from '../../../shared/events';
import { PlayerRepository } from '../../players/players.repository';
import {
  AuctionLot,
  AuctionProxyBid,
  auctionLotFromDatabase,
  auctionLotToResponse,
} from './auction.models';
import {
  ValidationException,
  NotFoundException,
  ForbiddenException,
} from '../../../utils/exceptions';
import { runWithLock, LockDomain } from '../../../shared/transaction-runner';
import { logger } from '../../../config/logger.config';
import { Draft } from '../drafts.model';
import { getRosterBudgetDataWithClient } from './auction-budget-calculator';
import { resolvePriceWithClient } from './auction-price-resolver';

export interface NominationResult {
  lot: AuctionLot;
  message: string;
}

export interface SetMaxBidResult {
  proxyBid: AuctionProxyBid;
  lot: AuctionLot;
  outbidNotifications: Array<{ userId: string; lotId: number; playerId: number }>;
  message: string;
}

export interface FastAuctionSettings {
  auctionMode: 'fast' | 'slow';
  nominationSeconds: number;
  resetOnBidSeconds: number;
  minBid: number;
  minIncrement: number;
}

export interface FastAuctionState {
  auctionMode: 'fast';
  activeLot: AuctionLot | null;
  currentNominatorRosterId: number;
  nominationNumber: number;
  nominationDeadline: Date | null;
  budgets: Array<{ rosterId: number; spent: number; remaining: number }>;
}

export class FastAuctionService {
  constructor(
    private readonly lotRepo: AuctionLotRepository,
    private readonly draftRepo: DraftRepository,
    private readonly rosterRepo: RosterRepository,
    private readonly leagueRepo: LeagueRepository,
    private readonly orderService: DraftOrderService,
    private readonly playerRepo: PlayerRepository,
    private readonly pool: Pool
  ) {}

  /**
   * Get fast auction settings from draft settings with defaults
   */
  getSettings(draft: Draft): FastAuctionSettings {
    return {
      auctionMode: draft.settings?.auctionMode ?? 'slow',
      nominationSeconds: draft.settings?.nominationSeconds ?? 60,
      resetOnBidSeconds: draft.settings?.resetOnBidSeconds ?? 15,
      minBid: draft.settings?.minBid ?? 1,
      minIncrement: draft.settings?.minIncrement ?? 1,
    };
  }

  /**
   * Set nominator as the opening bidder at startingBid (fast auction only).
   * Called after lot creation to make nomination count as the opening bid.
   */
  private async setNominatorAsOpeningBidder(
    client: PoolClient,
    lot: AuctionLot,
    nominatorRosterId: number,
    startingBid: number
  ): Promise<void> {
    // Update lot to set nominator as leader
    await client.query(
      `UPDATE auction_lots
       SET current_bidder_roster_id = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2`,
      [nominatorRosterId, lot.id]
    );

    // Insert proxy bid at starting bid
    await client.query(
      `INSERT INTO auction_proxy_bids (lot_id, roster_id, max_bid)
       VALUES ($1, $2, $3)`,
      [lot.id, nominatorRosterId, startingBid]
    );

    // Record opening bid in history
    await client.query(
      `INSERT INTO auction_bid_history (lot_id, roster_id, bid_amount, is_proxy)
       VALUES ($1, $2, $3, $4)`,
      [lot.id, nominatorRosterId, startingBid, false]
    );
  }

  /**
   * Get the current nominator for a fast auction draft
   */
  async getCurrentNominator(draftId: number): Promise<{ rosterId: number; userId: string } | null> {
    const draft = await this.draftRepo.findById(draftId);
    if (!draft || !draft.currentRosterId) {
      return null;
    }
    const roster = await this.rosterRepo.findById(draft.currentRosterId);
    if (!roster || !roster.userId) {
      return null;
    }
    return { rosterId: roster.id, userId: roster.userId };
  }

  /**
   * Nominate a player in fast auction mode
   * - Only current nominator can nominate
   * - Only one active lot allowed at a time
   * Uses advisory lock to prevent race conditions with concurrent nominations
   */
  async nominate(draftId: number, userId: string, playerId: number): Promise<NominationResult> {
    // Get draft and validate
    const draft = await this.draftRepo.findById(draftId);
    if (!draft) {
      throw new NotFoundException('Draft not found');
    }
    if (draft.status !== 'in_progress') {
      throw new ValidationException('Draft is not in progress');
    }
    if (draft.draftType !== 'auction') {
      throw new ValidationException('Draft is not an auction draft');
    }

    const settings = this.getSettings(draft);
    if (settings.auctionMode !== 'fast') {
      throw new ValidationException('This is not a fast auction draft');
    }

    // Check if user is current nominator
    const roster = await this.rosterRepo.findByLeagueAndUser(draft.leagueId, userId);
    if (!roster) {
      throw new ForbiddenException('You are not a member of this league');
    }
    if (draft.currentRosterId !== roster.id) {
      throw new ForbiddenException('It is not your turn to nominate');
    }

    // Use transaction with advisory lock to prevent race condition
    const { lot, playerName } = await runWithLock(
      this.pool,
      LockDomain.DRAFT,
      draftId,
      async (client) => {
        // Check no active lot exists (inside lock)
        const hasActive = await this.lotRepo.hasActiveLotWithClient(client, draftId);
        if (hasActive) {
          throw new ValidationException('There is already an active lot - wait for it to complete');
        }

        // Validate player (using client to avoid connection churn)
        const player = await this.playerRepo.findByIdWithClient(client, playerId);
        if (!player) {
          throw new NotFoundException('Player not found');
        }

        // Check player not already drafted (using transaction client for atomicity)
        const draftedResult = await client.query(
          'SELECT EXISTS(SELECT 1 FROM draft_picks WHERE draft_id = $1 AND player_id = $2) as exists',
          [draftId, playerId]
        );
        if (draftedResult.rows[0].exists) {
          throw new ValidationException('Player has already been drafted');
        }

        // Check player not already nominated (using transaction client for atomicity)
        const existingLot = await this.lotRepo.findLotByDraftAndPlayerWithClient(
          client,
          draftId,
          playerId
        );
        if (existingLot) {
          throw new ValidationException('Player has already been nominated in this draft');
        }

        // Validate budget and roster slots (using transaction client for isolation)
        const budgetInfo = await this.lotRepo.getRosterBudgetDataWithClient(client, draftId, roster.id);
        const league = await this.leagueRepo.findById(draft.leagueId, client);
        if (!league) {
          throw new NotFoundException('League not found');
        }

        const rosterSlots = league.leagueSettings?.rosterSlots ?? 15;

        // Check roster has slots
        if (budgetInfo.wonCount >= rosterSlots) {
          throw new ValidationException('Your roster is full');
        }

        // Budget validation: ensure nominator can afford startingBid
        // (In fast auction, nominator becomes leader at startingBid)
        const totalBudget = league.leagueSettings?.auctionBudget ?? 200;
        const remainingSlots = rosterSlots - budgetInfo.wonCount - 1; // -1 for this nomination
        const requiredReserve = Math.max(0, remainingSlots) * settings.minBid;
        const maxAffordable = totalBudget - budgetInfo.spent - requiredReserve - budgetInfo.leadingCommitment;

        if (settings.minBid > maxAffordable) {
          throw new ValidationException(
            `Cannot nominate: insufficient budget. Maximum affordable bid is $${maxAffordable}`
          );
        }

        // Calculate bid deadline for fast auction
        const bidDeadline = new Date(Date.now() + settings.nominationSeconds * 1000);

        // Create the lot using transaction client
        const lot = await this.lotRepo.createLotWithClient(
          client,
          draftId,
          playerId,
          roster.id,
          bidDeadline,
          settings.minBid
        );

        // Fast auction: Nominator becomes the leader at startingBid
        await this.setNominatorAsOpeningBidder(client, lot, roster.id, settings.minBid);
        lot.currentBidderRosterId = roster.id;

        return { lot, playerName: player.fullName };
      }
    );

    // Post-commit: Publish domain event for socket emission
    // Include serverTime for client clock synchronization
    const eventBus = tryGetEventBus();
    eventBus?.publish({
      type: EventTypes.AUCTION_LOT_STARTED,
      payload: {
        draftId,
        lot: auctionLotToResponse(lot),
        serverTime: Date.now(),
      },
    });

    return {
      lot,
      message: `${playerName} nominated for $${settings.minBid}`,
    };
  }

  /**
   * Set max bid in fast auction mode
   * Reuses slow auction logic but adds timer reset on price/leader change
   */
  async setMaxBid(
    draftId: number,
    userId: string,
    lotId: number,
    maxBid: number
  ): Promise<SetMaxBidResult> {
    // Get draft and validate fast auction mode
    const draft = await this.draftRepo.findById(draftId);
    if (!draft) {
      throw new NotFoundException('Draft not found');
    }

    const settings = this.getSettings(draft);
    if (settings.auctionMode !== 'fast') {
      throw new ValidationException('This is not a fast auction draft');
    }

    // Validate user is a member first (outside transaction)
    const roster = await this.rosterRepo.findByLeagueAndUser(draft.leagueId, userId);
    if (!roster) {
      throw new ForbiddenException('You are not a member of this league');
    }

    // Use transaction with lot-based lock for atomic operations
    // Lock the specific lot to serialize concurrent bids on the same lot
    const { finalLot, outbidNotifications: rawNotifications, playerId } = await runWithLock(
      this.pool,
      LockDomain.AUCTION,
      lotId,
      async (client) => {

        // Get lot with lock
        const lotResult = await client.query('SELECT * FROM auction_lots WHERE id = $1 FOR UPDATE', [
          lotId,
        ]);
        if (lotResult.rows.length === 0) {
          throw new NotFoundException('Lot not found');
        }
        const lot = auctionLotFromDatabase(lotResult.rows[0]);

        if (lot.draftId !== draftId) {
          throw new NotFoundException('Lot does not belong to this draft');
        }
        if (lot.status !== 'active') {
          throw new ValidationException('Lot is no longer active');
        }

        // Validate bid meets minimum
        const minRequired = lot.currentBid + settings.minIncrement;
        if (maxBid < minRequired && lot.currentBidderRosterId !== roster.id) {
          throw new ValidationException(`Bid must be at least $${minRequired}`);
        }

        // Leaders cannot lower their maxBid below the current bid
        // This prevents invalid state where leader's commitment < displayed price
        if (lot.currentBidderRosterId === roster.id && maxBid < lot.currentBid) {
          throw new ValidationException(`Cannot lower max bid below current bid ($${lot.currentBid})`);
        }

        // Validate budget (using transaction client for isolation)
        const league = await this.leagueRepo.findById(draft.leagueId, client);
        if (!league) {
          throw new NotFoundException('League not found');
        }

        const totalBudget = league.leagueSettings?.auctionBudget ?? 200;
        const rosterSlots = league.leagueSettings?.rosterSlots ?? 15;
        const budgetInfo = await getRosterBudgetDataWithClient(client, draftId, roster.id);

        // Calculate remaining slots and required reserve
        const remainingSlots = rosterSlots - budgetInfo.wonCount - 1; // -1 for this lot
        const requiredReserve = Math.max(0, remainingSlots) * settings.minBid;

        // Calculate max affordable bid
        let maxAffordable =
          totalBudget - budgetInfo.spent - requiredReserve - budgetInfo.leadingCommitment;
        const isLeadingThisLot = lot.currentBidderRosterId === roster.id;
        if (isLeadingThisLot) {
          maxAffordable += lot.currentBid; // Can reuse current commitment
        }

        if (maxBid > maxAffordable) {
          throw new ValidationException(`Maximum affordable bid is $${maxAffordable}`);
        }

        // Worst-case budget validation: ensure user can fill remaining roster at minBid
        const worstCaseSpend = maxBid + budgetInfo.spent + requiredReserve;
        if (worstCaseSpend > totalBudget) {
          const maxAllowed = totalBudget - budgetInfo.spent - requiredReserve;
          throw new ValidationException(
            `Bid would leave insufficient budget for remaining roster slots. Maximum: $${maxAllowed}`
          );
        }

        // Upsert proxy bid
        await client.query(
          `INSERT INTO auction_proxy_bids (lot_id, roster_id, max_bid)
           VALUES ($1, $2, $3)
           ON CONFLICT (lot_id, roster_id)
           DO UPDATE SET max_bid = EXCLUDED.max_bid, updated_at = CURRENT_TIMESTAMP`,
          [lotId, roster.id, maxBid]
        );

        // Resolve price using shared utility
        const result = await resolvePriceWithClient(client, lot, settings);

        // Fast auction specific: reset timer on price/leader change
        let finalLot = result.updatedLot;
        if (result.priceChanged || result.leaderChanged) {
          const newDeadline = new Date(Date.now() + settings.resetOnBidSeconds * 1000);
          // Only extend deadline, never shorten it
          if (newDeadline > finalLot.bidDeadline) {
            await client.query(
              'UPDATE auction_lots SET bid_deadline = $1, updated_at = NOW() WHERE id = $2',
              [newDeadline, lotId]
            );
            finalLot = { ...finalLot, bidDeadline: newDeadline };
          }
        }

        return { finalLot, outbidNotifications: result.outbidNotifications, playerId: lot.playerId };
      }
    );

    // Post-commit: Publish domain event for socket emission
    // Include serverTime for client clock synchronization
    const eventBus = tryGetEventBus();
    eventBus?.publish({
      type: EventTypes.AUCTION_BID,
      payload: {
        draftId,
        lot: auctionLotToResponse(finalLot),
        serverTime: Date.now(),
      },
    });

    // Get proxy bid for response
    const proxyBidResult = await this.lotRepo.getProxyBid(lotId, roster.id);

    // Handle outbid notifications via domain events
    // Batch lookup rosters to avoid N+1 queries
    const userOutbidNotifications: Array<{ userId: string; lotId: number; playerId: number }> = [];
    if (rawNotifications.length > 0) {
      const rosterIds = rawNotifications.map((n) => n.rosterId);
      const rosters = await this.rosterRepo.findByIds(rosterIds);
      const rosterMap = new Map(rosters.map((r) => [r.id, r]));

      for (const notification of rawNotifications) {
        const outbidRoster = rosterMap.get(notification.rosterId);
        if (outbidRoster && outbidRoster.userId) {
          userOutbidNotifications.push({
            userId: outbidRoster.userId,
            lotId: notification.lotId,
            playerId,
          });
          // Publish outbid notification via domain event bus
          eventBus?.publish({
            type: EventTypes.AUCTION_OUTBID,
            userId: outbidRoster.userId,
            payload: {
              lot_id: notification.lotId,
              player_id: playerId,
              new_bid: finalLot.currentBid,
            },
          });
        }
      }
    }

    return {
      proxyBid: proxyBidResult!,
      lot: finalLot,
      outbidNotifications: userOutbidNotifications,
      message: `Max bid set to $${maxBid}`,
    };
  }

  /**
   * Advance to the next nominator after a lot is settled
   * Uses transaction with advisory lock to prevent race conditions
   */
  async advanceNominator(draftId: number): Promise<void> {
    const result = await runWithLock(
      this.pool,
      LockDomain.DRAFT,
      draftId,
      async (client) => {
        // Re-read draft inside transaction with lock
        const draftResult = await client.query(
          'SELECT * FROM drafts WHERE id = $1 FOR UPDATE',
          [draftId]
        );
        if (draftResult.rows.length === 0) {
          throw new NotFoundException('Draft not found');
        }

        const draft = draftResult.rows[0];
        const auctionMode = draft.settings?.auctionMode ?? 'slow';
        if (auctionMode !== 'fast') {
          return null; // Not a fast auction, nothing to do
        }

        // Get draft order
        const orderResult = await client.query(
          'SELECT * FROM draft_order WHERE draft_id = $1 ORDER BY draft_position',
          [draftId]
        );
        if (orderResult.rows.length === 0) {
          return null;
        }

        const order = orderResult.rows;
        const nominationSeconds = draft.settings?.nominationSeconds ?? 60;

        // Calculate next nominator
        const nextPick = (draft.current_pick || 0) + 1;
        const nextIndex = (nextPick - 1) % order.length;
        const nextNominator = order[nextIndex];

        // Calculate nomination deadline
        const nominationDeadline = new Date(Date.now() + nominationSeconds * 1000);

        // Update draft with new nominator and deadline
        await client.query(
          `UPDATE drafts
           SET current_pick = $1, current_roster_id = $2, pick_deadline = $3, updated_at = NOW()
           WHERE id = $4`,
          [nextPick, nextNominator.roster_id, nominationDeadline, draftId]
        );

        return {
          nominatorRosterId: nextNominator.roster_id,
          nominationNumber: nextPick,
          nominationDeadline,
        };
      }
    );

    // Post-commit: Publish domain event for nominator change
    if (result) {
      const eventBus = tryGetEventBus();
      eventBus?.publish({
        type: EventTypes.AUCTION_NOMINATOR_CHANGED,
        payload: {
          draftId,
          nominatorRosterId: result.nominatorRosterId,
          nominationNumber: result.nominationNumber,
          nominationDeadline: result.nominationDeadline.toISOString(),
        },
      });
    }
  }

  /**
   * Force advance to next nominator - used as fallback when normal advancement fails
   * This is a simplified version that directly updates the database
   */
  async forceAdvanceNominator(draftId: number): Promise<void> {
    try {
      const result = await runWithLock(
        this.pool,
        LockDomain.DRAFT,
        draftId,
        async (client) => {
          // Get current draft state and order count
          const draftResult = await client.query(
            'SELECT current_pick, settings FROM drafts WHERE id = $1 FOR UPDATE',
            [draftId]
          );
          if (draftResult.rows.length === 0) {
            return null;
          }

          const draft = draftResult.rows[0];
          const nominationSeconds = draft.settings?.nominationSeconds ?? 60;

          const orderCountResult = await client.query(
            'SELECT COUNT(*) as count FROM draft_order WHERE draft_id = $1',
            [draftId]
          );
          const orderCount = parseInt(orderCountResult.rows[0].count, 10);
          if (orderCount === 0) {
            return null;
          }

          const nextPick = (draft.current_pick || 0) + 1;
          const nextIndex = (nextPick - 1) % orderCount;
          const nominationDeadline = new Date(Date.now() + nominationSeconds * 1000);

          // Get the next nominator
          const nextNominatorResult = await client.query(
            `SELECT roster_id FROM draft_order
             WHERE draft_id = $1
             ORDER BY draft_position
             LIMIT 1 OFFSET $2`,
            [draftId, nextIndex]
          );

          if (nextNominatorResult.rows.length === 0) {
            return null;
          }

          const nextRosterId = nextNominatorResult.rows[0].roster_id;

          // Update draft
          await client.query(
            `UPDATE drafts
             SET current_pick = $1, current_roster_id = $2, pick_deadline = $3, updated_at = NOW()
             WHERE id = $4`,
            [nextPick, nextRosterId, nominationDeadline, draftId]
          );

          return { nextRosterId, nextPick, nominationDeadline };
        }
      );

      if (result) {
        // Post-commit: Publish domain event for nominator change
        const eventBus = tryGetEventBus();
        eventBus?.publish({
          type: EventTypes.AUCTION_NOMINATOR_CHANGED,
          payload: {
            draftId,
            nominatorRosterId: result.nextRosterId,
            nominationNumber: result.nextPick,
            nominationDeadline: result.nominationDeadline.toISOString(),
          },
        });

        logger.info('Force advanced nominator', {
          draftId,
          nextPick: result.nextPick,
          nextRosterId: result.nextRosterId,
        });
      }
    } catch (error) {
      logger.error('Force advance nominator failed', { draftId, error });
      throw error;
    }
  }

  /**
   * Auto-nominate a random available player when nominator times out
   * Uses transaction with draft lock to prevent race conditions with concurrent nominations
   */
  async autoNominate(draftId: number): Promise<NominationResult | null> {
    // Pre-flight check outside transaction (fast path for common case)
    const draft = await this.draftRepo.findById(draftId);
    if (!draft) {
      throw new NotFoundException('Draft not found');
    }

    const settings = this.getSettings(draft);
    if (settings.auctionMode !== 'fast') {
      return null;
    }

    if (!draft.currentRosterId) {
      logger.warn('No current nominator for auto-nomination', { draftId });
      return null;
    }

    // Use transaction with draft lock to prevent race conditions
    const result = await runWithLock(
      this.pool,
      LockDomain.DRAFT,
      draftId,
      async (client) => {
        // Re-check for active lot under lock (prevents race with user nomination)
        const hasActive = await this.lotRepo.hasActiveLotWithClient(client, draftId);
        if (hasActive) {
          return null; // Already has an active lot, nothing to do
        }

        // Find a random available player using SQL-level filtering
        // (avoids loading all players into memory)
        const randomPlayer = await this.playerRepo.findRandomEligiblePlayerForAuction(client, draftId);

        if (!randomPlayer) {
          logger.warn('No available players for auto-nomination', { draftId });
          return { noPlayers: true } as const;
        }

        // Validate budget for auto-nomination
        const budgetInfo = await this.lotRepo.getRosterBudgetDataWithClient(client, draftId, draft.currentRosterId!);
        const league = await this.leagueRepo.findById(draft.leagueId, client);
        if (!league) {
          throw new NotFoundException('League not found');
        }

        const totalBudget = league.leagueSettings?.auctionBudget ?? 200;
        const rosterSlots = league.leagueSettings?.rosterSlots ?? 15;
        const remainingSlots = rosterSlots - budgetInfo.wonCount - 1;
        const requiredReserve = Math.max(0, remainingSlots) * settings.minBid;
        const maxAffordable = totalBudget - budgetInfo.spent - requiredReserve - budgetInfo.leadingCommitment;

        if (settings.minBid > maxAffordable) {
          logger.warn('Auto-nomination skipped: nominator cannot afford starting bid', {
            draftId,
            nominatorRosterId: draft.currentRosterId,
            maxAffordable,
            minBid: settings.minBid,
          });
          return { noPlayers: true } as const; // Triggers advanceNominator()
        }

        // Calculate bid deadline
        const bidDeadline = new Date(Date.now() + settings.nominationSeconds * 1000);

        // Create the lot using transaction client
        const lot = await this.lotRepo.createLotWithClient(
          client,
          draftId,
          randomPlayer.id,
          draft.currentRosterId!,
          bidDeadline,
          settings.minBid
        );

        // Fast auction: Nominator becomes the leader at startingBid
        await this.setNominatorAsOpeningBidder(client, lot, draft.currentRosterId!, settings.minBid);
        lot.currentBidderRosterId = draft.currentRosterId!;

        return { lot, playerName: randomPlayer.fullName, playerId: randomPlayer.id };
      }
    );

    // Handle no-op case (already has active lot)
    if (result === null) {
      return null;
    }

    // Handle no available players case - advance nominator after transaction
    if ('noPlayers' in result) {
      await this.advanceNominator(draftId);
      return null;
    }

    // Post-commit: Log and publish domain event
    logger.info('Auto-nominated player', {
      draftId,
      playerId: result.playerId,
      playerName: result.playerName,
      nominatorRosterId: draft.currentRosterId,
    });

    const eventBus = tryGetEventBus();
    eventBus?.publish({
      type: EventTypes.AUCTION_LOT_STARTED,
      payload: {
        draftId,
        lot: auctionLotToResponse(result.lot),
        serverTime: Date.now(),
        isAutoNomination: true,
      },
    });

    return {
      lot: result.lot,
      message: `Auto-nominated ${result.playerName} for $${settings.minBid}`,
    };
  }

  /**
   * Get current fast auction state
   */
  async getState(draftId: number): Promise<FastAuctionState> {
    const draft = await this.draftRepo.findById(draftId);
    if (!draft) {
      throw new NotFoundException('Draft not found');
    }

    const activeLots = await this.lotRepo.findActiveLotsByDraft(draftId);
    const budgets = await this.getAllBudgets(draft);

    return {
      auctionMode: 'fast',
      activeLot: activeLots.length > 0 ? activeLots[0] : null,
      currentNominatorRosterId: draft.currentRosterId!,
      nominationNumber: draft.currentPick || 1,
      nominationDeadline: draft.pickDeadline,
      budgets: budgets.map((b) => ({
        rosterId: b.rosterId,
        spent: b.spent,
        remaining: b.available,
      })),
    };
  }

  /**
   * Get budget info for all rosters in a draft
   * (Moved from SlowAuctionService to eliminate service-to-service dependency)
   */
  private async getAllBudgets(draft: Draft): Promise<
    {
      rosterId: number;
      totalBudget: number;
      spent: number;
      leadingCommitment: number;
      available: number;
      wonCount: number;
    }[]
  > {
    const league = await this.leagueRepo.findById(draft.leagueId);
    if (!league) throw new NotFoundException('League not found');

    const totalBudget = league.leagueSettings?.auctionBudget ?? 200;
    const rosterSlots = league.leagueSettings?.rosterSlots ?? 15;
    const settings = this.getSettings(draft);

    const rosters = await this.rosterRepo.findByLeagueId(draft.leagueId);
    const rosterIds = rosters.map((r) => r.id);

    // Get all budget data in a single batch query
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
      };
    });
  }
}
