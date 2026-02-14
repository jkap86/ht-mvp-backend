import { Pool, PoolClient } from 'pg';
import { AuctionLotRepository } from './auction-lot.repository';
import { DraftRepository } from '../drafts.repository';
import type { RosterRepository, LeagueRepository } from '../../leagues/leagues.repository';
import { DraftOrderService } from '../draft-order.service';
import { EventTypes, tryGetEventBus } from '../../../shared/events';
import type { PlayerRepository } from '../../players/players.repository';
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
import { Draft, FastAuctionTimeoutAction } from '../drafts.model';
import { resolvePriceWithClient } from './auction-price-resolver';
import { calculateMaxAffordableBid, calculateFallbackMaxBid, canAffordMinBid, computeAvailableBudget } from '../../../domain/auction/budget';
import { computeExtendedDeadline } from '../../../domain/auction/lot-timer';
import { assessNominatorEligibility } from '../../../domain/auction/nomination';
import { finalizeDraftCompletion } from '../draft-completion.utils';
import type { RosterPlayersRepository } from '../../rosters/rosters.repository';
import { container, KEYS } from '../../../container';

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
  maxLotDurationSeconds: number | null;
  fastAuctionTimeoutAction: FastAuctionTimeoutAction;
}

export interface FastAuctionState {
  auctionMode: 'fast';
  activeLot: AuctionLot | null;
  currentNominatorRosterId: number;
  nominationNumber: number;
  nominationDeadline: Date | null;
  budgets: Array<{ rosterId: number; spent: number; remaining: number }>;
}

/**
 * LOCK CONTRACT:
 * - nominate() locks DRAFT(draftId) — serializes nominations
 * - setMaxBid() locks AUCTION(lotId) — serializes bids per lot
 * - advanceNominator() locks DRAFT(draftId) — serializes draft state transitions
 *
 * No method holds both DRAFT and AUCTION locks simultaneously.
 * If that ever becomes necessary, acquire AUCTION first (priority 5)
 * then DRAFT (priority 7), per lock ordering rules in shared/locks.ts.
 */
export class FastAuctionService {
  // Throttle map for outbid notifications: key = `${userId}:${lotId}`, value = lastSentTimestamp
  private outbidThrottle = new Map<string, number>();
  private static readonly OUTBID_THROTTLE_MS = 3000; // 3 seconds

  constructor(
    private readonly lotRepo: AuctionLotRepository,
    private readonly draftRepo: DraftRepository,
    private readonly rosterRepo: RosterRepository,
    private readonly leagueRepo: LeagueRepository,
    private readonly orderService: DraftOrderService,
    private readonly playerRepo: PlayerRepository,
    private readonly pool: Pool
  ) {}

  private cleanupOutbidThrottle(): void {
    const now = Date.now();
    for (const [key, timestamp] of this.outbidThrottle) {
      if (now - timestamp > FastAuctionService.OUTBID_THROTTLE_MS) {
        this.outbidThrottle.delete(key);
      }
    }
  }

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
      maxLotDurationSeconds: draft.settings?.maxLotDurationSeconds ?? null,
      fastAuctionTimeoutAction: draft.settings?.fastAuctionTimeoutAction ?? 'auto_nominate_and_open_bid',
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
    startingBid: number,
    idempotencyKey?: string
  ): Promise<void> {
    // Update lot to set nominator as leader
    await client.query(
      `UPDATE auction_lots
       SET current_bidder_roster_id = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2`,
      [nominatorRosterId, lot.id]
    );

    // Insert proxy bid at starting bid (ON CONFLICT for retry safety)
    await client.query(
      `INSERT INTO auction_proxy_bids (lot_id, roster_id, max_bid)
       VALUES ($1, $2, $3)
       ON CONFLICT (lot_id, roster_id)
       DO UPDATE SET max_bid = EXCLUDED.max_bid, updated_at = CURRENT_TIMESTAMP`,
      [lot.id, nominatorRosterId, startingBid]
    );

    // Record opening bid in history (ON CONFLICT for proper idempotency)
    await client.query(
      `INSERT INTO auction_bid_history (lot_id, roster_id, bid_amount, is_proxy, idempotency_key)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (lot_id, roster_id, idempotency_key) WHERE idempotency_key IS NOT NULL
       DO NOTHING`,
      [lot.id, nominatorRosterId, startingBid, false, idempotencyKey ?? null]
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
  async nominate(draftId: number, userId: string, playerId: number, idempotencyKey?: string): Promise<NominationResult> {
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
    const { lot, playerName, openingBid } = await runWithLock(
      this.pool,
      LockDomain.DRAFT,
      draftId,
      async (client) => {
        // Re-validate draft state inside lock (prevents TOCTOU race)
        const draftCheck = await client.query('SELECT status, settings, current_roster_id FROM drafts WHERE id = $1 FOR UPDATE', [draftId]);
        if (draftCheck.rows.length === 0) {
          throw new NotFoundException('Draft not found');
        }
        const lockedDraft = draftCheck.rows[0];
        if (lockedDraft.status !== 'in_progress') {
          throw new ValidationException('Draft is not in progress');
        }
        if (lockedDraft.settings?.auctionMode !== 'fast') {
          throw new ValidationException('This is not a fast auction draft');
        }
        if (lockedDraft.current_roster_id !== roster.id) {
          throw new ForbiddenException('It is not your turn to nominate');
        }

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
        const maxAffordable = calculateMaxAffordableBid(
          totalBudget, rosterSlots, budgetInfo,
          0,      // no existing lot bid yet (lot not created)
          false,  // not yet leading any lot for this nomination
          settings.minBid
        );

        const openingBid = settings.minBid;

        if (openingBid > maxAffordable) {
          throw new ValidationException(
            `Cannot nominate: insufficient budget. Maximum affordable bid is $${maxAffordable}`
          );
        }

        // Calculate bid deadline for fast auction
        let bidDeadline = new Date(Date.now() + settings.nominationSeconds * 1000);
        if (settings.maxLotDurationSeconds) {
          const maxDeadline = new Date(Date.now() + settings.maxLotDurationSeconds * 1000);
          if (bidDeadline > maxDeadline) {
            bidDeadline = maxDeadline;
          }
        }

        // Create the lot using transaction client
        const lot = await this.lotRepo.createLotWithClient(
          client,
          draftId,
          playerId,
          roster.id,
          bidDeadline,
          openingBid,
          undefined,
          idempotencyKey,
          league.activeLeagueSeasonId
        );

        // Fast auction: Nominator becomes the leader at openingBid
        await this.setNominatorAsOpeningBidder(client, lot, roster.id, openingBid, idempotencyKey);
        lot.currentBidderRosterId = roster.id;

        return { lot, playerName: player.fullName, openingBid };
      }
    );

    logger.info('auction:nomination:created', {
      draftId,
      lotId: lot.id,
      playerId,
      playerName,
      nominatorRosterId: roster.id,
      openingBid,
    });

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
      message: `${playerName} nominated for $${openingBid}`,
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
    maxBid: number,
    idempotencyKey?: string
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
        // Idempotency check: return existing result if same key was already used
        if (idempotencyKey) {
          const existing = await client.query(
            `SELECT id FROM auction_bid_history WHERE lot_id = $1 AND roster_id = $2 AND idempotency_key = $3`,
            [lotId, roster.id, idempotencyKey]
          );
          if (existing.rows.length > 0) {
            const currentLotResult = await client.query('SELECT * FROM auction_lots WHERE id = $1', [lotId]);
            if (!currentLotResult.rows[0]) {
              throw new NotFoundException(`Auction lot not found: ${lotId}`);
            }
            const currentLot = auctionLotFromDatabase(currentLotResult.rows[0]);
            return { finalLot: currentLot, outbidNotifications: [], playerId: currentLot.playerId };
          }
        }

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

        // Re-validate roster membership inside lock (prevents stale read race)
        const rosterCheck = await client.query(
          'SELECT id FROM rosters WHERE league_id = $1 AND user_id = $2',
          [draft.leagueId, userId]
        );
        if (rosterCheck.rows.length === 0) {
          throw new ForbiddenException('You are not a member of this league');
        }

        // Paused check: bid_deadline is NULL when draft is paused
        if (!lot.bidDeadline) {
          throw new ValidationException('Draft is paused; bidding is suspended');
        }

        // Hard deadline check: reject bids after lot expiry (server-authoritative)
        if (lot.bidDeadline && new Date() >= lot.bidDeadline) {
          throw new ValidationException('Lot has expired; please refresh');
        }

        // Validate bid meets minimum
        // No increment needed when there's no leader to outbid (e.g., auto_nominate_no_open_bid)
        const minRequired = lot.currentBidderRosterId === null
          ? lot.currentBid
          : lot.currentBid + settings.minIncrement;
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
        const budgetInfo = await this.lotRepo.getRosterBudgetDataWithClient(client, draftId, roster.id);

        // Guard: reject if roster is already full
        if (budgetInfo.wonCount >= rosterSlots) {
          throw new ValidationException('Cannot bid: your roster is already full');
        }

        // Calculate max affordable bid
        const isLeadingThisLot = lot.currentBidderRosterId === roster.id;
        const maxAffordable = calculateMaxAffordableBid(
          totalBudget, rosterSlots, budgetInfo,
          lot.currentBid,
          isLeadingThisLot,
          settings.minBid
        );

        if (maxBid > maxAffordable) {
          throw new ValidationException(`Maximum affordable bid is $${maxAffordable}`);
        }

        // Worst-case budget validation: ensure user can fill remaining roster at minBid
        const remainingSlots = rosterSlots - budgetInfo.wonCount - 1; // -1 for this lot
        const requiredReserve = Math.max(0, remainingSlots) * settings.minBid;
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

        // Record bid in history (always, for consistency with slow auction)
        await client.query(
          `INSERT INTO auction_bid_history (lot_id, roster_id, bid_amount, is_proxy, idempotency_key)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (lot_id, roster_id, idempotency_key) WHERE idempotency_key IS NOT NULL
           DO NOTHING`,
          [lotId, roster.id, maxBid, true, idempotencyKey ?? null]
        );

        // Resolve price using shared utility
        const result = await resolvePriceWithClient(client, lot, settings);

        // Fast auction specific: reset timer on price/leader change
        let finalLot = result.updatedLot;
        if (result.priceChanged || result.leaderChanged) {
          const timerResult = computeExtendedDeadline(
            new Date(),
            finalLot.bidDeadline,
            lot.createdAt,
            settings.resetOnBidSeconds,
            settings.maxLotDurationSeconds
          );

          if (timerResult.shouldExtend) {
            await client.query(
              'UPDATE auction_lots SET bid_deadline = $1, updated_at = NOW() WHERE id = $2',
              [timerResult.newDeadline, lotId]
            );
            finalLot = { ...finalLot, bidDeadline: timerResult.newDeadline };
          }
        }

        return { finalLot, outbidNotifications: result.outbidNotifications, playerId: lot.playerId };
      }
    );

    logger.info('auction:bid:placed', {
      draftId,
      lotId,
      rosterId: roster.id,
      maxBid,
      currentBid: finalLot.currentBid,
      currentBidder: finalLot.currentBidderRosterId,
    });

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
    this.cleanupOutbidThrottle();
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

          // Throttle outbid notifications to prevent spam during rapid bid wars
          const throttleKey = `${outbidRoster.userId}:${notification.lotId}`;
          const lastSent = this.outbidThrottle.get(throttleKey) || 0;
          const now = Date.now();

          if (now - lastSent >= FastAuctionService.OUTBID_THROTTLE_MS) {
            this.outbidThrottle.set(throttleKey, now);
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
    }

    return {
      proxyBid: proxyBidResult!,
      lot: finalLot,
      outbidNotifications: userOutbidNotifications,
      message: `Max bid set to $${maxBid}`,
    };
  }

  /**
   * Shared lock body for advanceNominator and forceAdvanceNominator.
   * Acquires DRAFT lock, reads draft state, cycles through draft order to find
   * the next eligible nominator, and updates the database atomically.
   * Returns null if the draft is not in a state where advancement applies.
   */
  private async advanceNominatorInternal(draftId: number): Promise<{
    auctionComplete: boolean;
    leagueId?: number;
    nominatorRosterId?: number;
    nominationNumber?: number;
    nominationDeadline?: Date;
  } | null> {
    return runWithLock(
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
        if (draft.status !== 'in_progress') {
          return null; // Draft already completed or not started
        }
        const auctionMode = draft.settings?.auctionMode ?? 'slow';
        if (auctionMode !== 'fast') {
          return null; // Not a fast auction, nothing to do
        }

        // Check if any eligible players remain
        const hasEligiblePlayers = await this.playerRepo.findRandomEligiblePlayerForAuction(client, draftId);
        if (!hasEligiblePlayers) {
          return { auctionComplete: true, leagueId: draft.league_id };
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
        const minBid = draft.settings?.minBid ?? 1;

        // Get league settings for budget/slot checks
        const leagueResult = await client.query('SELECT * FROM leagues WHERE id = $1', [draft.league_id]);
        if (leagueResult.rows.length === 0) {
          return null;
        }
        const leagueSettings = leagueResult.rows[0].league_settings ?? {};
        const totalBudget = leagueSettings.auctionBudget ?? 200;
        const rosterSlots = leagueSettings.rosterSlots ?? 15;

        // Get all roster budget data in one query (using transaction client)
        const rosterIds = order.map((o: any) => o.roster_id);
        const budgetDataMap = await this.lotRepo.getAllRosterBudgetDataWithClient(client, draftId, rosterIds);

        // Try each team in order, starting from the next pick position
        const currentPick = draft.current_pick || 0;
        for (let i = 0; i < order.length; i++) {
          const nextPick = currentPick + 1 + i;
          const nextIndex = (nextPick - 1) % order.length;
          const candidate = order[nextIndex];
          const rosterId = candidate.roster_id;

          const budgetData = budgetDataMap.get(rosterId) ?? { spent: 0, wonCount: 0, leadingCommitment: 0 };

          // Check eligibility using domain function
          const eligibility = assessNominatorEligibility(budgetData, totalBudget, rosterSlots, minBid);
          if (!eligibility.eligible) {
            continue;
          }

          // Re-verify eligibility immediately before selection to prevent race conditions
          // A concurrent lot settlement could have filled this roster after we loaded budget data
          const freshBudgetData = await this.lotRepo.getRosterBudgetDataWithClient(client, draftId, rosterId);
          const freshEligibility = assessNominatorEligibility(freshBudgetData, totalBudget, rosterSlots, minBid);
          if (!freshEligibility.eligible) {
            continue;
          }

          // This team is eligible - set them as next nominator
          const nominationDeadline = new Date(Date.now() + nominationSeconds * 1000);
          await client.query(
            `UPDATE drafts
             SET current_pick = $1, current_roster_id = $2, pick_deadline = $3, updated_at = NOW()
             WHERE id = $4`,
            [nextPick, rosterId, nominationDeadline, draftId]
          );

          return {
            auctionComplete: false,
            nominatorRosterId: rosterId,
            nominationNumber: nextPick,
            nominationDeadline,
          };
        }

        // All teams are ineligible - auction should complete
        return { auctionComplete: true, leagueId: draft.league_id };
      }
    );
  }

  /**
   * Advance to the next nominator after a lot is settled.
   * Skips ineligible teams (full roster or can't afford minBid).
   * If no teams can nominate (or no eligible players remain), triggers auction completion.
   * Uses transaction with advisory lock to prevent race conditions.
   */
  async advanceNominator(draftId: number, timeoutSkippedRosterId?: number): Promise<void> {
    const result = await this.advanceNominatorInternal(draftId);
    if (!result) {
      return;
    }

    if (result.auctionComplete) {
      // Finalize the auction draft
      await this.completeAuctionDraft(draftId, result.leagueId!);
      return;
    }

    // Post-commit: Publish domain event for nominator change
    const eventBus = tryGetEventBus();
    eventBus?.publish({
      type: EventTypes.AUCTION_NOMINATOR_CHANGED,
      payload: {
        draftId,
        nominatorRosterId: result.nominatorRosterId,
        nominationNumber: result.nominationNumber,
        nominationDeadline: result.nominationDeadline!.toISOString(),
        ...(timeoutSkippedRosterId != null && { timeoutSkippedRosterId }),
      },
    });
  }

  /**
   * Force advance to next nominator - used as fallback when normal advancement fails
   * This is a simplified version that directly updates the database
   */
  async forceAdvanceNominator(draftId: number): Promise<void> {
    try {
      const result = await this.advanceNominatorInternal(draftId);
      if (!result) {
        return;
      }

      if (result.auctionComplete) {
        await this.completeAuctionDraft(draftId, result.leagueId!);
        return;
      }

      // Post-commit: Publish domain event for nominator change
      const eventBus = tryGetEventBus();
      eventBus?.publish({
        type: EventTypes.AUCTION_NOMINATOR_CHANGED,
        payload: {
          draftId,
          nominatorRosterId: result.nominatorRosterId,
          nominationNumber: result.nominationNumber,
          nominationDeadline: result.nominationDeadline!.toISOString(),
        },
      });

      logger.info('Force advanced nominator', {
        draftId,
        nextPick: result.nominationNumber,
        nextRosterId: result.nominatorRosterId,
      });
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

    const timeoutAction = settings.fastAuctionTimeoutAction;

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

        // Re-read draft state inside lock (prevents TOCTOU race with advanceNominator)
        const draftCheck = await client.query(
          'SELECT status, settings, current_roster_id FROM drafts WHERE id = $1 FOR UPDATE',
          [draftId]
        );
        if (draftCheck.rows.length === 0) {
          return null;
        }
        const lockedDraft = draftCheck.rows[0];
        if (lockedDraft.status !== 'in_progress') {
          return null;
        }
        if (lockedDraft.settings?.auctionMode !== 'fast') {
          return null;
        }
        const lockedCurrentRosterId: number | null = lockedDraft.current_roster_id;
        if (!lockedCurrentRosterId) {
          logger.warn('No current nominator for auto-nomination (inside lock)', { draftId });
          return null;
        }

        // auto_skip_nominator: skip lot creation entirely, just advance
        if (timeoutAction === 'auto_skip_nominator') {
          return { skipReason: 'timeout_skip' as const, skippedRosterId: lockedCurrentRosterId };
        }

        // Find best available player: queue → ADP → random
        const season = new Date().getFullYear();
        const bestAvailable = await this.playerRepo.findBestAvailablePlayerForAuction(
          client, draftId, lockedCurrentRosterId, season
        );

        if (!bestAvailable) {
          logger.warn('No available players for auto-nomination', { draftId });
          return { skipReason: 'no_eligible_players' as const };
        }

        const { player: selectedPlayer, source: selectionSource } = bestAvailable;

        // Validate budget for auto-nomination
        const budgetInfo = await this.lotRepo.getRosterBudgetDataWithClient(client, draftId, lockedCurrentRosterId);
        const league = await this.leagueRepo.findById(draft.leagueId, client);
        if (!league) {
          throw new NotFoundException('League not found');
        }

        const totalBudget = league.leagueSettings?.auctionBudget ?? 200;
        const rosterSlots = league.leagueSettings?.rosterSlots ?? 15;

        // Check roster full
        if (budgetInfo.wonCount >= rosterSlots) {
          logger.warn('Auto-nomination skipped: nominator roster is full', {
            draftId,
            nominatorRosterId: lockedCurrentRosterId,
            wonCount: budgetInfo.wonCount,
            rosterSlots,
          });
          return { skipReason: 'roster_full' as const };
        }

        if (!canAffordMinBid(totalBudget, rosterSlots, budgetInfo, settings.minBid)) {
          const maxAffordable = calculateMaxAffordableBid(
            totalBudget, rosterSlots, budgetInfo,
            0, false, settings.minBid
          );
          logger.warn('Auto-nomination skipped: nominator cannot afford starting bid', {
            draftId,
            nominatorRosterId: lockedCurrentRosterId,
            maxAffordable,
            minBid: settings.minBid,
          });
          return { skipReason: 'insufficient_budget' as const };
        }

        // Calculate bid deadline
        let bidDeadline = new Date(Date.now() + settings.nominationSeconds * 1000);
        if (settings.maxLotDurationSeconds) {
          const maxDeadline = new Date(Date.now() + settings.maxLotDurationSeconds * 1000);
          if (bidDeadline > maxDeadline) {
            bidDeadline = maxDeadline;
          }
        }

        // Create the lot using transaction client
        const lot = await this.lotRepo.createLotWithClient(
          client,
          draftId,
          selectedPlayer.id,
          lockedCurrentRosterId,
          bidDeadline,
          settings.minBid,
          undefined,
          undefined,
          league.activeLeagueSeasonId
        );

        // Calculate smart fallback max bid
        const fallbackMax = calculateFallbackMaxBid(
          totalBudget, rosterSlots, budgetInfo, settings.minBid
        );

        // auto_nominate_no_open_bid: create lot but skip opening bid
        // Lot starts with currentBidderRosterId = NULL, settles as passed if nobody bids
        if (timeoutAction !== 'auto_nominate_no_open_bid') {
          // auto_nominate_and_open_bid (default): Nominator becomes the leader at startingBid
          await this.setNominatorAsOpeningBidder(client, lot, lockedCurrentRosterId, settings.minBid);
          lot.currentBidderRosterId = lockedCurrentRosterId;

          // If smart max > minBid, update the proxy bid so AFK user has a real chance
          // No need to re-run price resolution — only one bidder at this point
          if (fallbackMax > settings.minBid) {
            await client.query(
              `UPDATE auction_proxy_bids
               SET max_bid = $1, updated_at = CURRENT_TIMESTAMP
               WHERE lot_id = $2 AND roster_id = $3`,
              [fallbackMax, lot.id, lockedCurrentRosterId]
            );
          }
        }

        return {
          lot,
          playerName: selectedPlayer.fullName,
          playerId: selectedPlayer.id,
          fallbackMaxBid: fallbackMax,
          selectionSource,
        };
      }
    );

    // Handle no-op case (already has active lot)
    if (result === null) {
      return null;
    }

    // Handle skip cases - advance to next nominator after transaction
    if ('skipReason' in result) {
      const isTimeoutSkip = result.skipReason === 'timeout_skip';
      if (isTimeoutSkip) {
        logger.info('Nomination timeout: skipping nominator', {
          draftId,
          skippedRosterId: 'skippedRosterId' in result ? result.skippedRosterId : undefined,
        });
      } else {
        logger.info('Auto-nomination skipped, advancing nominator', {
          draftId,
          skipReason: result.skipReason,
        });
      }
      await this.advanceNominator(
        draftId,
        isTimeoutSkip && 'skippedRosterId' in result ? result.skippedRosterId : undefined
      );
      return null;
    }

    // Post-commit: Log and publish domain event
    logger.info('Auto-nominated player', {
      draftId,
      playerId: result.playerId,
      playerName: result.playerName,
      nominatorRosterId: draft.currentRosterId,
      fallbackMaxBid: result.fallbackMaxBid,
      selectionSource: result.selectionSource,
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
      const available = computeAvailableBudget(totalBudget, rosterSlots, budgetData, settings.minBid);

      return {
        rosterId: roster.id,
        totalBudget,
        spent: budgetData.spent,
        leadingCommitment: budgetData.leadingCommitment,
        available,
        wonCount: budgetData.wonCount,
      };
    });
  }

  /**
   * Complete an auction draft: update status, populate rosters, generate schedule.
   * Called when no teams can nominate or no eligible players remain.
   */
  private async completeAuctionDraft(draftId: number, leagueId: number): Promise<void> {
    try {
      await runWithLock(
        this.pool,
        LockDomain.DRAFT,
        draftId,
        async (client) => {
          // Mark draft as completed first (idempotent on retry)
          await client.query(
            'UPDATE drafts SET status = $1, updated_at = NOW() WHERE id = $2',
            ['completed', draftId]
          );

          // Finalize: populate rosters, update league status, generate schedule
          const rosterPlayersRepo = container.resolve<RosterPlayersRepository>(KEYS.ROSTER_PLAYERS_REPO);
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
      );

      logger.info('Auction draft completed', { draftId, leagueId });

      // Post-commit: Publish draft completed event
      const eventBus = tryGetEventBus();
      eventBus?.publish({
        type: EventTypes.DRAFT_COMPLETED,
        payload: { draftId, leagueId },
      });
    } catch (error) {
      logger.error('Failed to complete auction draft', { draftId, leagueId, error });
      throw error;
    }
  }
}
