import { Pool } from 'pg';
import { TradesRepository, TradeItemsRepository, TradeVotesRepository } from './trades.repository';
import {
  RosterPlayersRepository,
  RosterTransactionsRepository,
} from '../rosters/rosters.repository';
import { RosterMutationService } from '../rosters/roster-mutation.service';
import { LeagueRepository, RosterRepository } from '../leagues/leagues.repository';
import { PlayerRepository } from '../players/players.repository';
import { TradeWithDetails, ProposeTradeRequest, CounterTradeRequest } from './trades.model';
import { EventListenerService } from '../chat/event-listener.service';

// Import use-cases
import {
  proposeTradeStandalone as proposeTradeUseCase,
  acceptTrade as acceptTradeUseCase,
  rejectTrade as rejectTradeUseCase,
  cancelTrade as cancelTradeUseCase,
  counterTrade as counterTradeUseCase,
  voteTrade as voteTradeUseCase,
  getTradesForLeague as getTradesForLeagueUseCase,
  getTradeById as getTradeByIdUseCase,
  invalidateTradesWithPlayer as invalidateTradesWithPlayerUseCase,
  processExpiredTrades as processExpiredTradesUseCase,
  processReviewCompleteTrades as processReviewCompleteTradesUseCase,
} from './use-cases';

/**
 * TradesService - Facade that coordinates trade use-cases
 *
 * This service delegates to individual use-case functions for business logic,
 * providing a unified interface for trade operations.
 */
export class TradesService {
  constructor(
    private readonly db: Pool,
    private readonly tradesRepo: TradesRepository,
    private readonly tradeItemsRepo: TradeItemsRepository,
    private readonly tradeVotesRepo: TradeVotesRepository,
    private readonly rosterRepo: RosterRepository,
    private readonly rosterPlayersRepo: RosterPlayersRepository,
    private readonly transactionsRepo: RosterTransactionsRepository,
    private readonly leagueRepo: LeagueRepository,
    private readonly playerRepo: PlayerRepository,
    private readonly eventListenerService?: EventListenerService,
    private readonly rosterMutationService?: RosterMutationService
  ) {}

  /**
   * Propose a new trade
   */
  async proposeTrade(
    leagueId: number,
    userId: string,
    request: ProposeTradeRequest
  ): Promise<TradeWithDetails> {
    return await proposeTradeUseCase(
      {
        db: this.db,
        tradesRepo: this.tradesRepo,
        tradeItemsRepo: this.tradeItemsRepo,
        rosterRepo: this.rosterRepo,
        rosterPlayersRepo: this.rosterPlayersRepo,
        leagueRepo: this.leagueRepo,
        playerRepo: this.playerRepo,
        eventListenerService: this.eventListenerService,
      },
      leagueId,
      userId,
      request
    );
  }

  /**
   * Accept a trade
   */
  async acceptTrade(tradeId: number, userId: string): Promise<TradeWithDetails> {
    return acceptTradeUseCase(
      {
        db: this.db,
        tradesRepo: this.tradesRepo,
        tradeItemsRepo: this.tradeItemsRepo,
        rosterRepo: this.rosterRepo,
        rosterPlayersRepo: this.rosterPlayersRepo,
        transactionsRepo: this.transactionsRepo,
        leagueRepo: this.leagueRepo,
        eventListenerService: this.eventListenerService,
        rosterMutationService: this.rosterMutationService,
      },
      tradeId,
      userId
    );
  }

  /**
   * Reject a trade
   */
  async rejectTrade(tradeId: number, userId: string): Promise<TradeWithDetails> {
    return rejectTradeUseCase(
      {
        db: this.db,
        tradesRepo: this.tradesRepo,
        rosterRepo: this.rosterRepo,
        eventListenerService: this.eventListenerService,
      },
      tradeId,
      userId
    );
  }

  /**
   * Cancel a trade (proposer only)
   */
  async cancelTrade(tradeId: number, userId: string): Promise<TradeWithDetails> {
    return cancelTradeUseCase(
      {
        db: this.db,
        tradesRepo: this.tradesRepo,
        rosterRepo: this.rosterRepo,
        eventListenerService: this.eventListenerService,
      },
      tradeId,
      userId
    );
  }

  /**
   * Counter a trade
   */
  async counterTrade(
    tradeId: number,
    userId: string,
    request: CounterTradeRequest
  ): Promise<TradeWithDetails> {
    return counterTradeUseCase(
      {
        db: this.db,
        tradesRepo: this.tradesRepo,
        tradeItemsRepo: this.tradeItemsRepo,
        rosterRepo: this.rosterRepo,
        rosterPlayersRepo: this.rosterPlayersRepo,
        leagueRepo: this.leagueRepo,
        playerRepo: this.playerRepo,
        eventListenerService: this.eventListenerService,
      },
      tradeId,
      userId,
      request
    );
  }

  /**
   * Vote on a trade during review period
   */
  async voteTrade(
    tradeId: number,
    userId: string,
    vote: 'approve' | 'veto'
  ): Promise<{ trade: TradeWithDetails; voteCount: { approve: number; veto: number } }> {
    return voteTradeUseCase(
      {
        db: this.db,
        tradesRepo: this.tradesRepo,
        tradeVotesRepo: this.tradeVotesRepo,
        rosterRepo: this.rosterRepo,
        leagueRepo: this.leagueRepo,
        eventListenerService: this.eventListenerService,
      },
      tradeId,
      userId,
      vote
    );
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
    return getTradesForLeagueUseCase(
      {
        tradesRepo: this.tradesRepo,
        rosterRepo: this.rosterRepo,
        leagueRepo: this.leagueRepo,
      },
      leagueId,
      userId,
      statuses,
      limit,
      offset
    );
  }

  /**
   * Get a single trade with details
   */
  async getTradeById(tradeId: number, userId: string, leagueId: number): Promise<TradeWithDetails> {
    return getTradeByIdUseCase(
      {
        tradesRepo: this.tradesRepo,
        rosterRepo: this.rosterRepo,
        leagueRepo: this.leagueRepo,
      },
      tradeId,
      userId,
      leagueId
    );
  }

  /**
   * Invalidate pending trades containing a dropped player
   */
  async invalidateTradesWithPlayer(leagueId: number, playerId: number): Promise<void> {
    return invalidateTradesWithPlayerUseCase({ db: this.db, tradesRepo: this.tradesRepo }, leagueId, playerId);
  }

  /**
   * Process expired trades (called by job)
   */
  async processExpiredTrades(): Promise<number> {
    return processExpiredTradesUseCase({ tradesRepo: this.tradesRepo });
  }

  /**
   * Process trades with completed review period (called by job)
   */
  async processReviewCompleteTrades(): Promise<number> {
    return processReviewCompleteTradesUseCase({
      db: this.db,
      tradesRepo: this.tradesRepo,
      tradeItemsRepo: this.tradeItemsRepo,
      tradeVotesRepo: this.tradeVotesRepo,
      rosterRepo: this.rosterRepo,
      rosterPlayersRepo: this.rosterPlayersRepo,
      transactionsRepo: this.transactionsRepo,
      leagueRepo: this.leagueRepo,
      eventListenerService: this.eventListenerService,
      rosterMutationService: this.rosterMutationService,
    });
  }
}
