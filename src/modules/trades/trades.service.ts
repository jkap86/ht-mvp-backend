import { Pool, PoolClient } from 'pg';
import { TradesRepository, TradeItemsRepository, TradeVotesRepository } from './trades.repository';
import { RosterPlayersRepository, RosterTransactionsRepository } from '../rosters/rosters.repository';
import { LeagueRepository, RosterRepository } from '../leagues/leagues.repository';
import { getSocketService } from '../../socket';
import {
  Trade,
  TradeWithDetails,
  ProposeTradeRequest,
  CounterTradeRequest,
  tradeWithDetailsToResponse,
} from './trades.model';
import {
  NotFoundException,
  ForbiddenException,
  ValidationException,
  ConflictException,
} from '../../utils/exceptions';

const DEFAULT_TRADE_EXPIRY_HOURS = 48;
const DEFAULT_REVIEW_HOURS = 24;
const DEFAULT_VETO_COUNT = 4;

export class TradesService {
  constructor(
    private readonly db: Pool,
    private readonly tradesRepo: TradesRepository,
    private readonly tradeItemsRepo: TradeItemsRepository,
    private readonly tradeVotesRepo: TradeVotesRepository,
    private readonly rosterRepo: RosterRepository,
    private readonly rosterPlayersRepo: RosterPlayersRepository,
    private readonly transactionsRepo: RosterTransactionsRepository,
    private readonly leagueRepo: LeagueRepository
  ) {}

  /**
   * Propose a new trade
   */
  async proposeTrade(
    leagueId: number,
    userId: string,
    request: ProposeTradeRequest
  ): Promise<TradeWithDetails> {
    // Validate user owns a roster in this league
    const proposerRoster = await this.rosterRepo.findByLeagueAndUser(leagueId, userId);
    if (!proposerRoster) {
      throw new ForbiddenException('You are not a member of this league');
    }

    // Validate recipient roster exists
    const recipientRoster = await this.rosterRepo.findById(request.recipientRosterId);
    if (!recipientRoster || recipientRoster.leagueId !== leagueId) {
      throw new NotFoundException('Recipient roster not found in this league');
    }

    if (proposerRoster.id === request.recipientRosterId) {
      throw new ValidationException('Cannot trade with yourself');
    }

    // Get league settings
    const league = await this.leagueRepo.findById(leagueId);
    if (!league) throw new NotFoundException('League not found');

    // Check trade deadline
    const tradeDeadline = league.settings?.trade_deadline;
    if (tradeDeadline && new Date(tradeDeadline) < new Date()) {
      throw new ValidationException('Trade deadline has passed');
    }

    // Validate players
    if (request.offeringPlayerIds.length === 0 && request.requestingPlayerIds.length === 0) {
      throw new ValidationException('Trade must include at least one player');
    }

    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [leagueId + 2000000]); // Trade lock

      // Validate offering players belong to proposer
      for (const playerId of request.offeringPlayerIds) {
        const playerRoster = await this.rosterPlayersRepo.findByRosterAndPlayer(
          proposerRoster.id,
          playerId,
          client
        );
        if (!playerRoster) {
          throw new ValidationException(`You do not own player ${playerId}`);
        }

        // Check player not in another pending trade
        const pendingTrades = await this.tradesRepo.findPendingByPlayer(leagueId, playerId);
        if (pendingTrades.length > 0) {
          throw new ConflictException(`Player ${playerId} is already in a pending trade`);
        }
      }

      // Validate requested players belong to recipient
      for (const playerId of request.requestingPlayerIds) {
        const playerRoster = await this.rosterPlayersRepo.findByRosterAndPlayer(
          request.recipientRosterId,
          playerId,
          client
        );
        if (!playerRoster) {
          throw new ValidationException(`Recipient does not own player ${playerId}`);
        }

        // Check player not in another pending trade
        const pendingTrades = await this.tradesRepo.findPendingByPlayer(leagueId, playerId);
        if (pendingTrades.length > 0) {
          throw new ConflictException(`Player ${playerId} is already in a pending trade`);
        }
      }

      // Calculate roster size changes and validate
      const netChangeProposer = request.requestingPlayerIds.length - request.offeringPlayerIds.length;
      const netChangeRecipient = request.offeringPlayerIds.length - request.requestingPlayerIds.length;
      const maxRosterSize = league.settings?.roster_size || 15;

      if (netChangeProposer > 0) {
        const proposerSize = await this.rosterPlayersRepo.getPlayerCount(proposerRoster.id, client);
        if (proposerSize + netChangeProposer > maxRosterSize) {
          throw new ValidationException('Trade would exceed your roster size limit');
        }
      }

      if (netChangeRecipient > 0) {
        const recipientSize = await this.rosterPlayersRepo.getPlayerCount(request.recipientRosterId, client);
        if (recipientSize + netChangeRecipient > maxRosterSize) {
          throw new ValidationException('Trade would exceed recipient roster size limit');
        }
      }

      // Create trade
      const expiryHours = league.settings?.trade_expiry_hours || DEFAULT_TRADE_EXPIRY_HOURS;
      const expiresAt = new Date(Date.now() + expiryHours * 60 * 60 * 1000);

      const trade = await this.tradesRepo.create(
        leagueId,
        proposerRoster.id,
        request.recipientRosterId,
        expiresAt,
        parseInt(league.season, 10),
        league.currentWeek || 1,
        request.message,
        undefined,
        client
      );

      // Get player details for items
      const items: Array<{
        playerId: number;
        fromRosterId: number;
        toRosterId: number;
        playerName: string;
        playerPosition?: string;
        playerTeam?: string;
      }> = [];

      // Players from proposer to recipient
      for (const playerId of request.offeringPlayerIds) {
        const playerInfo = await client.query(
          'SELECT full_name, position, team FROM players WHERE id = $1',
          [playerId]
        );
        if (playerInfo.rows.length > 0) {
          items.push({
            playerId,
            fromRosterId: proposerRoster.id,
            toRosterId: request.recipientRosterId,
            playerName: playerInfo.rows[0].full_name,
            playerPosition: playerInfo.rows[0].position,
            playerTeam: playerInfo.rows[0].team,
          });
        }
      }

      // Players from recipient to proposer
      for (const playerId of request.requestingPlayerIds) {
        const playerInfo = await client.query(
          'SELECT full_name, position, team FROM players WHERE id = $1',
          [playerId]
        );
        if (playerInfo.rows.length > 0) {
          items.push({
            playerId,
            fromRosterId: request.recipientRosterId,
            toRosterId: proposerRoster.id,
            playerName: playerInfo.rows[0].full_name,
            playerPosition: playerInfo.rows[0].position,
            playerTeam: playerInfo.rows[0].team,
          });
        }
      }

      await this.tradeItemsRepo.createBulk(trade.id, items, client);

      await client.query('COMMIT');

      // Get full trade details
      const tradeWithDetails = await this.tradesRepo.findByIdWithDetails(trade.id, proposerRoster.id);
      if (!tradeWithDetails) throw new Error('Failed to create trade');

      // Emit socket event
      try {
        const socket = getSocketService();
        socket.emitTradeProposed(leagueId, tradeWithDetailsToResponse(tradeWithDetails));
      } catch (socketError) {
        console.warn('Failed to emit trade proposed event:', socketError);
      }

      return tradeWithDetails;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Accept a trade
   */
  async acceptTrade(tradeId: number, userId: string): Promise<TradeWithDetails> {
    const trade = await this.tradesRepo.findById(tradeId);
    if (!trade) throw new NotFoundException('Trade not found');

    // Verify user is recipient
    const roster = await this.rosterRepo.findById(trade.recipientRosterId);
    if (!roster || roster.userId !== userId) {
      throw new ForbiddenException('Only the recipient can accept this trade');
    }

    if (trade.status !== 'pending') {
      throw new ValidationException(`Cannot accept trade with status: ${trade.status}`);
    }

    const league = await this.leagueRepo.findById(trade.leagueId);
    if (!league) throw new NotFoundException('League not found');

    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [trade.leagueId + 2000000]);

      // Re-validate all players still on correct rosters
      const items = await this.tradeItemsRepo.findByTrade(tradeId);
      for (const item of items) {
        const onRoster = await this.rosterPlayersRepo.findByRosterAndPlayer(
          item.fromRosterId,
          item.playerId,
          client
        );
        if (!onRoster) {
          throw new ConflictException(`Player ${item.playerName} is no longer on the expected roster`);
        }
      }

      // Check if review is enabled
      const reviewEnabled = league.settings?.trade_review_enabled === true;
      const votingEnabled = league.settings?.trade_voting_enabled === true;

      let updatedTrade: Trade;

      if (reviewEnabled || votingEnabled) {
        // Set review period
        const reviewHours = league.settings?.trade_review_hours || DEFAULT_REVIEW_HOURS;
        const reviewStartsAt = new Date();
        const reviewEndsAt = new Date(Date.now() + reviewHours * 60 * 60 * 1000);

        updatedTrade = await this.tradesRepo.setReviewPeriod(tradeId, reviewStartsAt, reviewEndsAt, client);
      } else {
        // Execute immediately
        await this.executeTrade(trade, client);
        updatedTrade = await this.tradesRepo.updateStatus(tradeId, 'completed', client);
      }

      await client.query('COMMIT');

      const tradeWithDetails = await this.tradesRepo.findByIdWithDetails(tradeId, roster.id);
      if (!tradeWithDetails) throw new Error('Failed to get trade details');

      // Emit socket event
      try {
        const socket = getSocketService();
        if (updatedTrade.status === 'completed') {
          socket.emitTradeCompleted(trade.leagueId, { tradeId: trade.id });
        } else {
          socket.emitTradeAccepted(trade.leagueId, {
            tradeId: trade.id,
            reviewEndsAt: updatedTrade.reviewEndsAt,
          });
        }
      } catch (socketError) {
        console.warn('Failed to emit trade event:', socketError);
      }

      return tradeWithDetails;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Reject a trade
   */
  async rejectTrade(tradeId: number, userId: string): Promise<TradeWithDetails> {
    const trade = await this.tradesRepo.findById(tradeId);
    if (!trade) throw new NotFoundException('Trade not found');

    const roster = await this.rosterRepo.findById(trade.recipientRosterId);
    if (!roster || roster.userId !== userId) {
      throw new ForbiddenException('Only the recipient can reject this trade');
    }

    if (trade.status !== 'pending') {
      throw new ValidationException(`Cannot reject trade with status: ${trade.status}`);
    }

    await this.tradesRepo.updateStatus(tradeId, 'rejected');

    const tradeWithDetails = await this.tradesRepo.findByIdWithDetails(tradeId, roster.id);
    if (!tradeWithDetails) throw new Error('Failed to get trade details');

    try {
      const socket = getSocketService();
      socket.emitTradeRejected(trade.leagueId, { tradeId: trade.id });
    } catch (socketError) {
      console.warn('Failed to emit trade rejected event:', socketError);
    }

    return tradeWithDetails;
  }

  /**
   * Cancel a trade (proposer only)
   */
  async cancelTrade(tradeId: number, userId: string): Promise<TradeWithDetails> {
    const trade = await this.tradesRepo.findById(tradeId);
    if (!trade) throw new NotFoundException('Trade not found');

    const roster = await this.rosterRepo.findById(trade.proposerRosterId);
    if (!roster || roster.userId !== userId) {
      throw new ForbiddenException('Only the proposer can cancel this trade');
    }

    if (trade.status !== 'pending') {
      throw new ValidationException(`Cannot cancel trade with status: ${trade.status}`);
    }

    await this.tradesRepo.updateStatus(tradeId, 'cancelled');

    const tradeWithDetails = await this.tradesRepo.findByIdWithDetails(tradeId, roster.id);
    if (!tradeWithDetails) throw new Error('Failed to get trade details');

    try {
      const socket = getSocketService();
      socket.emitTradeCancelled(trade.leagueId, { tradeId: trade.id });
    } catch (socketError) {
      console.warn('Failed to emit trade cancelled event:', socketError);
    }

    return tradeWithDetails;
  }

  /**
   * Counter a trade
   */
  async counterTrade(
    tradeId: number,
    userId: string,
    request: CounterTradeRequest
  ): Promise<TradeWithDetails> {
    const originalTrade = await this.tradesRepo.findById(tradeId);
    if (!originalTrade) throw new NotFoundException('Trade not found');

    const recipientRoster = await this.rosterRepo.findById(originalTrade.recipientRosterId);
    if (!recipientRoster || recipientRoster.userId !== userId) {
      throw new ForbiddenException('Only the recipient can counter this trade');
    }

    if (originalTrade.status !== 'pending') {
      throw new ValidationException(`Cannot counter trade with status: ${originalTrade.status}`);
    }

    // Mark original as countered
    await this.tradesRepo.updateStatus(tradeId, 'countered');

    // Create new trade with swapped proposer/recipient
    const newTrade = await this.proposeTrade(originalTrade.leagueId, userId, {
      recipientRosterId: originalTrade.proposerRosterId,
      offeringPlayerIds: request.offeringPlayerIds,
      requestingPlayerIds: request.requestingPlayerIds,
      message: request.message,
    });

    try {
      const socket = getSocketService();
      socket.emitTradeCountered(originalTrade.leagueId, {
        originalTradeId: tradeId,
        newTrade: tradeWithDetailsToResponse(newTrade),
      });
    } catch (socketError) {
      console.warn('Failed to emit trade countered event:', socketError);
    }

    return newTrade;
  }

  /**
   * Vote on a trade during review period
   */
  async voteTrade(
    tradeId: number,
    userId: string,
    vote: 'approve' | 'veto'
  ): Promise<{ trade: TradeWithDetails; voteCount: { approve: number; veto: number } }> {
    const trade = await this.tradesRepo.findById(tradeId);
    if (!trade) throw new NotFoundException('Trade not found');

    if (trade.status !== 'in_review') {
      throw new ValidationException('Trade is not in review period');
    }

    // Get user's roster
    const roster = await this.rosterRepo.findByLeagueAndUser(trade.leagueId, userId);
    if (!roster) {
      throw new ForbiddenException('You are not a member of this league');
    }

    // Cannot vote on own trade
    if (roster.id === trade.proposerRosterId || roster.id === trade.recipientRosterId) {
      throw new ForbiddenException('Cannot vote on your own trade');
    }

    // Check if already voted
    const hasVoted = await this.tradeVotesRepo.hasVoted(tradeId, roster.id);
    if (hasVoted) {
      throw new ConflictException('You have already voted on this trade');
    }

    await this.tradeVotesRepo.create(tradeId, roster.id, vote);

    const voteCount = await this.tradeVotesRepo.countVotes(tradeId);

    // Check if veto threshold reached
    const league = await this.leagueRepo.findById(trade.leagueId);
    const vetoThreshold = league?.settings?.trade_veto_count || DEFAULT_VETO_COUNT;

    if (voteCount.veto >= vetoThreshold) {
      await this.tradesRepo.updateStatus(tradeId, 'vetoed');

      try {
        const socket = getSocketService();
        socket.emitTradeVetoed(trade.leagueId, { tradeId: trade.id });
      } catch (socketError) {
        console.warn('Failed to emit trade vetoed event:', socketError);
      }
    } else {
      try {
        const socket = getSocketService();
        socket.emitTradeVoteCast(trade.leagueId, { tradeId: trade.id, votes: voteCount });
      } catch (socketError) {
        console.warn('Failed to emit vote event:', socketError);
      }
    }

    const tradeWithDetails = await this.tradesRepo.findByIdWithDetails(tradeId, roster.id);
    if (!tradeWithDetails) throw new Error('Failed to get trade details');

    return { trade: tradeWithDetails, voteCount };
  }

  /**
   * Execute trade (move players)
   */
  private async executeTrade(trade: Trade, client: PoolClient): Promise<void> {
    const items = await this.tradeItemsRepo.findByTrade(trade.id);

    // Re-validate all players
    for (const item of items) {
      const onRoster = await this.rosterPlayersRepo.findByRosterAndPlayer(
        item.fromRosterId,
        item.playerId,
        client
      );
      if (!onRoster) {
        throw new ConflictException(`Player ${item.playerName} is no longer available`);
      }
    }

    // Execute movements
    for (const item of items) {
      // Remove from source
      await this.rosterPlayersRepo.removePlayer(item.fromRosterId, item.playerId, client);

      // Add to destination
      await this.rosterPlayersRepo.addPlayer(item.toRosterId, item.playerId, 'trade', client);

      // Record transactions
      const dropTx = await this.transactionsRepo.create(
        trade.leagueId,
        item.fromRosterId,
        item.playerId,
        'trade',
        trade.season,
        trade.week,
        undefined,
        client
      );

      await this.transactionsRepo.create(
        trade.leagueId,
        item.toRosterId,
        item.playerId,
        'trade',
        trade.season,
        trade.week,
        dropTx.id,
        client
      );
    }
  }

  /**
   * Invalidate pending trades containing a dropped player
   */
  async invalidateTradesWithPlayer(leagueId: number, playerId: number): Promise<void> {
    const pendingTrades = await this.tradesRepo.findPendingByPlayer(leagueId, playerId);

    for (const trade of pendingTrades) {
      await this.tradesRepo.updateStatus(trade.id, 'expired');

      try {
        const socket = getSocketService();
        socket.emitTradeInvalidated(trade.leagueId, {
          tradeId: trade.id,
          reason: 'A player involved in this trade is no longer available',
        });
      } catch (socketError) {
        console.warn('Failed to emit trade invalidated event:', socketError);
      }
    }
  }

  /**
   * Process expired trades (called by job)
   */
  async processExpiredTrades(): Promise<number> {
    const expired = await this.tradesRepo.findExpiredTrades();

    for (const trade of expired) {
      await this.tradesRepo.updateStatus(trade.id, 'expired');

      try {
        const socket = getSocketService();
        socket.emitTradeExpired(trade.leagueId, { tradeId: trade.id });
      } catch (socketError) {
        console.warn('Failed to emit trade expired event:', socketError);
      }
    }

    return expired.length;
  }

  /**
   * Process trades with completed review period (called by job)
   */
  async processReviewCompleteTrades(): Promise<number> {
    const trades = await this.tradesRepo.findReviewCompleteTrades();
    let processed = 0;

    for (const trade of trades) {
      const voteCount = await this.tradeVotesRepo.countVotes(trade.id);
      const league = await this.leagueRepo.findById(trade.leagueId);
      const vetoThreshold = league?.settings?.trade_veto_count || DEFAULT_VETO_COUNT;

      const client = await this.db.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock($1)', [trade.leagueId + 2000000]);

        if (voteCount.veto >= vetoThreshold) {
          await this.tradesRepo.updateStatus(trade.id, 'vetoed', client);

          try {
            const socket = getSocketService();
            socket.emitTradeVetoed(trade.leagueId, { tradeId: trade.id });
          } catch (socketError) {
            console.warn('Failed to emit trade vetoed event:', socketError);
          }
        } else {
          await this.executeTrade(trade, client);
          await this.tradesRepo.updateStatus(trade.id, 'completed', client);

          try {
            const socket = getSocketService();
            socket.emitTradeCompleted(trade.leagueId, { tradeId: trade.id });
          } catch (socketError) {
            console.warn('Failed to emit trade completed event:', socketError);
          }
        }

        await client.query('COMMIT');
        processed++;
      } catch (error) {
        await client.query('ROLLBACK');
        console.error(`Failed to process trade ${trade.id}:`, error);
      } finally {
        client.release();
      }
    }

    return processed;
  }

  /**
   * Get trades for a league
   */
  async getTradesForLeague(
    leagueId: number,
    userId: string,
    statuses?: string[],
    limit?: number,
    offset?: number
  ): Promise<TradeWithDetails[]> {
    const isMember = await this.leagueRepo.isUserMember(leagueId, userId);
    if (!isMember) throw new ForbiddenException('Not a league member');

    const roster = await this.rosterRepo.findByLeagueAndUser(leagueId, userId);
    const trades = await this.tradesRepo.findByLeague(
      leagueId,
      statuses as any[],
      limit,
      offset
    );

    const tradesWithDetails: TradeWithDetails[] = [];
    for (const trade of trades) {
      const details = await this.tradesRepo.findByIdWithDetails(trade.id, roster?.id);
      if (details) tradesWithDetails.push(details);
    }

    return tradesWithDetails;
  }

  /**
   * Get a single trade with details
   */
  async getTradeById(tradeId: number, userId: string): Promise<TradeWithDetails> {
    const trade = await this.tradesRepo.findById(tradeId);
    if (!trade) throw new NotFoundException('Trade not found');

    const isMember = await this.leagueRepo.isUserMember(trade.leagueId, userId);
    if (!isMember) throw new ForbiddenException('Not a league member');

    const roster = await this.rosterRepo.findByLeagueAndUser(trade.leagueId, userId);
    const details = await this.tradesRepo.findByIdWithDetails(tradeId, roster?.id);
    if (!details) throw new NotFoundException('Trade not found');

    return details;
  }
}
