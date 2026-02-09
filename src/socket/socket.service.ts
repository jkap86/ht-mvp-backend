import { Server as HttpServer } from 'http';
import { Server, Socket } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { verifyToken } from '../utils/jwt';
import { env, logger } from '../config/env.config';
import { getRedisClient, isRedisAvailable } from '../config/redis.config';
import { container, KEYS } from '../container';
import { LeagueRepository } from '../modules/leagues/leagues.repository';
import { DraftRepository } from '../modules/drafts/drafts.repository';
import { SOCKET_EVENTS, ROOM_NAMES } from '../constants/socket-events';
import {
  socketRateLimitMiddleware,
  trackUserConnections,
} from '../middleware/socket-rate-limit.middleware';

// Membership cache configuration
const MEMBERSHIP_CACHE_TTL_SECONDS = 120; // 2 minutes
const MEMBERSHIP_CACHE_PREFIX = 'socket_membership:';

interface AuthenticatedSocket extends Socket {
  userId?: string;
  username?: string;
}

export class SocketService {
  private io: Server;
  // Note: Removed userSockets map in favor of user rooms for horizontal scaling support.
  // Each user socket now joins a room named `user:{userId}` which works with Redis adapter.

  // In-memory membership cache fallback (used when Redis unavailable)
  private membershipCache = new Map<string, { isMember: boolean; expiresAt: number }>();

  /**
   * Check if a user is a member of a league with caching.
   * Uses Redis when available, falls back to in-memory cache.
   */
  private async checkMembershipCached(leagueId: number, userId: string): Promise<boolean> {
    const cacheKey = `${leagueId}:${userId}`;

    if (isRedisAvailable()) {
      try {
        const redis = getRedisClient();
        const redisKey = `${MEMBERSHIP_CACHE_PREFIX}${cacheKey}`;
        const cached = await redis.get(redisKey);
        if (cached !== null) {
          return cached === '1';
        }
        // Cache miss - query DB
        const leagueRepo = container.resolve<LeagueRepository>(KEYS.LEAGUE_REPO);
        const isMember = await leagueRepo.isUserMember(leagueId, userId);
        // Cache the result
        await redis.setex(redisKey, MEMBERSHIP_CACHE_TTL_SECONDS, isMember ? '1' : '0');
        return isMember;
      } catch (error) {
        logger.error('Redis membership cache error, falling back to DB', { error });
        // Fall through to direct DB query
      }
    } else {
      // In-memory cache fallback
      const cached = this.membershipCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        return cached.isMember;
      }
    }

    // Direct DB query (fallback or no Redis)
    const leagueRepo = container.resolve<LeagueRepository>(KEYS.LEAGUE_REPO);
    const isMember = await leagueRepo.isUserMember(leagueId, userId);

    // Store in in-memory cache if Redis not available
    if (!isRedisAvailable()) {
      this.membershipCache.set(cacheKey, {
        isMember,
        expiresAt: Date.now() + MEMBERSHIP_CACHE_TTL_SECONDS * 1000,
      });
    }

    return isMember;
  }

  /**
   * Invalidate membership cache for a user in a league.
   * Call this when a user joins/leaves/is kicked from a league.
   */
  async invalidateMembershipCache(leagueId: number, userId: string): Promise<void> {
    const cacheKey = `${leagueId}:${userId}`;

    if (isRedisAvailable()) {
      try {
        const redis = getRedisClient();
        await redis.del(`${MEMBERSHIP_CACHE_PREFIX}${cacheKey}`);
      } catch (error) {
        logger.error('Failed to invalidate Redis membership cache', { error, leagueId, userId });
      }
    }

    // Also clear from in-memory cache
    this.membershipCache.delete(cacheKey);
  }

  constructor(httpServer: HttpServer) {
    this.io = new Server(httpServer, {
      cors: {
        origin: (origin, callback) => {
          // Allow requests with no origin (mobile apps, Postman)
          if (!origin) return callback(null, true);

          // Dev: allow any localhost/127.0.0.1 port, local network IPs, and emulator hosts
          if (env.NODE_ENV !== 'production') {
            if (
              origin.startsWith('http://localhost:') ||
              origin.startsWith('http://127.0.0.1:') ||
              origin.startsWith('https://localhost:') ||
              origin.startsWith('http://192.168.') ||
              origin.startsWith('http://10.0.2.2:') || // Android emulator
              /^http:\/\/172\.(1[6-9]|2[0-9]|3[0-1])\./.test(origin) // Docker networks (172.16-31.x.x)
            ) {
              return callback(null, true);
            }
          }

          // Prod: only allow configured FRONTEND_URL
          if (env.FRONTEND_URL && origin === env.FRONTEND_URL) {
            return callback(null, true);
          }

          logger.warn(`Socket.IO CORS rejected origin: ${origin}`);
          return callback(new Error('Not allowed by CORS'));
        },
        methods: ['GET', 'POST'],
        credentials: true,
      },
    });

    // Configure Redis adapter for horizontal scaling
    if (env.REDIS_HOST) {
      const pubClient = getRedisClient();
      const subClient = pubClient.duplicate();
      this.io.adapter(createAdapter(pubClient, subClient));
      logger.info('Socket.io using Redis adapter for horizontal scaling');
    }

    this.setupMiddleware();
    this.setupEventHandlers();
  }

  private setupMiddleware(): void {
    // Rate limiting middleware (applied first to block DoS before authentication)
    this.io.use(socketRateLimitMiddleware);

    // Authentication middleware
    this.io.use(async (socket: AuthenticatedSocket, next) => {
      try {
        // Only accept token from handshake.auth, not query string (security: query params get logged)
        const token = socket.handshake.auth.token;

        if (!token) {
          return next(new Error('Authentication required'));
        }

        const payload = verifyToken(token as string);
        socket.userId = payload.userId;
        socket.username = payload.username;
        next();
      } catch (_error) {
        next(new Error('Invalid token'));
      }
    });
  }

  private setupEventHandlers(): void {
    this.io.on('connection', (socket: AuthenticatedSocket) => {
      logger.info(`Socket connected: ${socket.id} (user: ${socket.userId})`);

      // Track concurrent connections per user (prevent resource exhaustion)
      trackUserConnections(socket);

      // Join user-specific room for targeted emissions (works across instances with Redis adapter)
      if (socket.userId) {
        socket.join(ROOM_NAMES.user(socket.userId));
      }

      // Join league room (with membership verification)
      socket.on(SOCKET_EVENTS.LEAGUE.JOIN, async (leagueId: number) => {
        if (!socket.userId) {
          socket.emit(SOCKET_EVENTS.APP.ERROR, { message: 'Not authenticated' });
          return;
        }

        // Validate leagueId is a positive integer
        if (typeof leagueId !== 'number' || !Number.isInteger(leagueId) || leagueId <= 0) {
          socket.emit(SOCKET_EVENTS.APP.ERROR, { message: 'Invalid league ID' });
          return;
        }

        try {
          // Use cached membership check to reduce DB load
          const isMember = await this.checkMembershipCached(leagueId, socket.userId);

          if (!isMember) {
            socket.emit(SOCKET_EVENTS.APP.ERROR, { message: 'Not a member of this league' });
            logger.warn(`User ${socket.userId} denied access to league ${leagueId}`);
            return;
          }

          const room = ROOM_NAMES.league(leagueId);
          socket.join(room);
          logger.info(`User ${socket.userId} joined league room ${leagueId}`);
        } catch (error) {
          logger.error(`Error joining league room: ${error}`);
          socket.emit(SOCKET_EVENTS.APP.ERROR, { message: 'Failed to join league room' });
        }
      });

      // Leave league room
      socket.on(SOCKET_EVENTS.LEAGUE.LEAVE, (leagueId: number) => {
        // Validate leagueId is a positive integer
        if (typeof leagueId !== 'number' || !Number.isInteger(leagueId) || leagueId <= 0) {
          socket.emit(SOCKET_EVENTS.APP.ERROR, { message: 'Invalid league ID' });
          return;
        }

        const room = ROOM_NAMES.league(leagueId);
        socket.leave(room);
        logger.info(`User ${socket.userId} left league room ${leagueId}`);
      });

      // Join draft room (with membership verification)
      socket.on(SOCKET_EVENTS.DRAFT.JOIN, async (draftId: number) => {
        if (!socket.userId) {
          socket.emit(SOCKET_EVENTS.APP.ERROR, { message: 'Not authenticated' });
          return;
        }

        // Validate draftId is a positive integer
        if (typeof draftId !== 'number' || !Number.isInteger(draftId) || draftId <= 0) {
          socket.emit(SOCKET_EVENTS.APP.ERROR, { message: 'Invalid draft ID' });
          return;
        }

        try {
          const draftRepo = container.resolve<DraftRepository>(KEYS.DRAFT_REPO);

          // Get draft to find its league
          const draft = await draftRepo.findById(draftId);
          if (!draft) {
            socket.emit(SOCKET_EVENTS.APP.ERROR, { message: 'Draft not found' });
            return;
          }

          // Check if user is member of the draft's league (cached)
          const isMember = await this.checkMembershipCached(draft.leagueId, socket.userId);
          if (!isMember) {
            socket.emit(SOCKET_EVENTS.APP.ERROR, { message: 'Not a member of this league' });
            logger.warn(`User ${socket.userId} denied access to draft ${draftId}`);
            return;
          }

          const room = ROOM_NAMES.draft(draftId);
          socket.join(room);
          logger.info(`User ${socket.userId} joined draft room ${draftId}`);

          // Notify others in the draft room
          socket.to(room).emit(SOCKET_EVENTS.DRAFT.USER_JOINED, {
            userId: socket.userId,
            username: socket.username,
          });
        } catch (error) {
          logger.error(`Error joining draft room: ${error}`);
          socket.emit(SOCKET_EVENTS.APP.ERROR, { message: 'Failed to join draft room' });
        }
      });

      // Leave draft room
      socket.on(SOCKET_EVENTS.DRAFT.LEAVE, (draftId: number) => {
        // Validate draftId is a positive integer
        if (typeof draftId !== 'number' || !Number.isInteger(draftId) || draftId <= 0) {
          socket.emit(SOCKET_EVENTS.APP.ERROR, { message: 'Invalid draft ID' });
          return;
        }

        const room = ROOM_NAMES.draft(draftId);
        socket.leave(room);
        logger.info(`User ${socket.userId} left draft room ${draftId}`);

        socket.to(room).emit(SOCKET_EVENTS.DRAFT.USER_LEFT, {
          userId: socket.userId,
          username: socket.username,
        });
      });

      // Handle disconnection
      socket.on('disconnect', (reason) => {
        logger.info(`Socket disconnected: ${socket.id} (reason: ${reason})`);
        // Socket.IO automatically removes socket from all rooms on disconnect
      });
    });
  }

  // Emit draft pick to all users in draft room
  emitDraftPick(draftId: number, pick: any): void {
    this.io.to(ROOM_NAMES.draft(draftId)).emit(SOCKET_EVENTS.DRAFT.PICK_MADE, pick);
  }

  // Emit draft created event to all users in league room
  emitDraftCreated(leagueId: number, draft: any): void {
    this.io.to(ROOM_NAMES.league(leagueId)).emit(SOCKET_EVENTS.DRAFT.CREATED, draft);
  }

  // Emit draft started event
  emitDraftStarted(draftId: number, draft: any): void {
    this.io.to(ROOM_NAMES.draft(draftId)).emit(SOCKET_EVENTS.DRAFT.STARTED, draft);
  }

  // Emit draft paused event
  emitDraftPaused(draftId: number, draft: any): void {
    this.io.to(ROOM_NAMES.draft(draftId)).emit(SOCKET_EVENTS.DRAFT.PAUSED, draft);
  }

  // Emit draft resumed event
  emitDraftResumed(draftId: number, draft: any): void {
    this.io.to(ROOM_NAMES.draft(draftId)).emit(SOCKET_EVENTS.DRAFT.RESUMED, draft);
  }

  // Emit draft completed event
  emitDraftCompleted(draftId: number, draft: any): void {
    this.io.to(ROOM_NAMES.draft(draftId)).emit(SOCKET_EVENTS.DRAFT.COMPLETED, draft);
  }

  // Emit pick undone event
  emitPickUndone(draftId: number, data: { pick: any; draft: any }): void {
    this.io.to(ROOM_NAMES.draft(draftId)).emit(SOCKET_EVENTS.DRAFT.PICK_UNDONE, data);
  }

  // Emit next pick info (whose turn, deadline)
  emitNextPick(draftId: number, pickInfo: any): void {
    this.io.to(ROOM_NAMES.draft(draftId)).emit(SOCKET_EVENTS.DRAFT.NEXT_PICK, pickInfo);
  }

  // Emit queue update event when a player is removed from all queues
  emitQueueUpdated(draftId: number, data: { playerId: number; action: string }): void {
    this.io.to(ROOM_NAMES.draft(draftId)).emit(SOCKET_EVENTS.DRAFT.QUEUE_UPDATED, data);
  }

  // Emit autodraft toggled event when a user enables/disables autodraft
  emitAutodraftToggled(
    draftId: number,
    data: { rosterId: number; enabled: boolean; forced: boolean }
  ): void {
    this.io.to(ROOM_NAMES.draft(draftId)).emit(SOCKET_EVENTS.DRAFT.AUTODRAFT_TOGGLED, data);
  }

  // Emit draft settings updated event when commissioner changes settings
  emitDraftSettingsUpdated(draftId: number, draft: any): void {
    this.io.to(ROOM_NAMES.draft(draftId)).emit(SOCKET_EVENTS.DRAFT.SETTINGS_UPDATED, draft);
  }

  // Emit pick traded event when a draft pick asset changes ownership
  emitPickTraded(
    leagueId: number,
    data: {
      pickAssetId: number;
      season: number;
      round: number;
      previousOwnerRosterId: number;
      newOwnerRosterId: number;
      tradeId: number;
    }
  ): void {
    this.io.to(ROOM_NAMES.league(leagueId)).emit(SOCKET_EVENTS.DRAFT.PICK_TRADED, data);
  }

  // Emit chat message to all users in league room
  emitChatMessage(leagueId: number, message: any): void {
    this.io.to(ROOM_NAMES.league(leagueId)).emit(SOCKET_EVENTS.CHAT.MESSAGE, message);
  }

  // Emit direct message to a specific user
  emitDmMessage(userId: string, conversationId: number, message: any): void {
    this.emitToUser(userId, SOCKET_EVENTS.DM.MESSAGE, { conversationId, message });
  }

  // Emit DM read notification to a specific user
  emitDmRead(userId: string, conversationId: number, readByUserId: string): void {
    this.emitToUser(userId, SOCKET_EVENTS.DM.READ, { conversationId, readBy: readByUserId });
  }

  // Emit auction lot created event
  // Note: Caller passes complete payload (including lot, serverTime, etc.)
  // We emit as-is to avoid double-wrapping
  emitAuctionLotCreated(draftId: number, data: any): void {
    this.io.to(ROOM_NAMES.draft(draftId)).emit(SOCKET_EVENTS.AUCTION.LOT_CREATED, data);
  }

  // Emit auction lot updated event (new bid placed)
  // Note: Caller passes complete payload (including lot, serverTime, etc.)
  // We emit as-is to avoid double-wrapping
  emitAuctionLotUpdated(draftId: number, data: any): void {
    this.io.to(ROOM_NAMES.draft(draftId)).emit(SOCKET_EVENTS.AUCTION.LOT_UPDATED, data);
  }

  // Emit auction lot won event
  emitAuctionLotWon(
    draftId: number,
    data: { lotId: number; playerId: number; winnerRosterId: number; price: number }
  ): void {
    this.io.to(ROOM_NAMES.draft(draftId)).emit(SOCKET_EVENTS.AUCTION.LOT_WON, data);
  }

  // Emit auction lot passed event (no bids)
  emitAuctionLotPassed(draftId: number, data: { lotId: number; playerId: number }): void {
    this.io.to(ROOM_NAMES.draft(draftId)).emit(SOCKET_EVENTS.AUCTION.LOT_PASSED, data);
  }

  // Emit outbid notification to a specific user
  emitAuctionOutbid(userId: string, data: any): void {
    this.emitToUser(userId, SOCKET_EVENTS.AUCTION.OUTBID, data);
  }

  // Emit nominator changed event (for fast auction)
  emitAuctionNominatorChanged(
    draftId: number,
    data: { nominatorRosterId: number; nominationNumber: number; nominationDeadline?: string }
  ): void {
    this.io.to(ROOM_NAMES.draft(draftId)).emit(SOCKET_EVENTS.AUCTION.NOMINATOR_CHANGED, data);
  }

  // Emit auction error to a specific user (for failed bids/nominations)
  emitAuctionError(userId: string, data: { action: string; message: string }): void {
    this.emitToUser(userId, SOCKET_EVENTS.AUCTION.ERROR, data);
  }

  // Derby events (draft order selection phase)

  // Emit full derby state
  emitDerbyState(draftId: number, data: any): void {
    this.io.to(ROOM_NAMES.draft(draftId)).emit(SOCKET_EVENTS.DERBY.STATE, data);
  }

  // Emit derby slot picked event
  emitDerbySlotPicked(draftId: number, data: any): void {
    this.io.to(ROOM_NAMES.draft(draftId)).emit(SOCKET_EVENTS.DERBY.SLOT_PICKED, data);
  }

  // Emit derby turn changed event (timeout policy applied)
  emitDerbyTurnChanged(draftId: number, data: any): void {
    this.io.to(ROOM_NAMES.draft(draftId)).emit(SOCKET_EVENTS.DERBY.TURN_CHANGED, data);
  }

  // Emit derby phase transition event
  emitDerbyPhaseTransition(draftId: number, data: { phase: string }): void {
    this.io.to(ROOM_NAMES.draft(draftId)).emit(SOCKET_EVENTS.DERBY.PHASE_TRANSITION, data);
  }

  // Emit to specific user via user room (works across instances with Redis adapter)
  emitToUser(userId: string, event: string, data: any): void {
    this.io.to(ROOM_NAMES.user(userId)).emit(event, data);
  }

  // Trade events (emitted to league room)

  // Emit trade proposed event
  emitTradeProposed(leagueId: number, trade: any): void {
    this.io.to(ROOM_NAMES.league(leagueId)).emit(SOCKET_EVENTS.TRADE.PROPOSED, trade);
  }

  // Emit trade accepted event
  emitTradeAccepted(leagueId: number, trade: any): void {
    this.io.to(ROOM_NAMES.league(leagueId)).emit(SOCKET_EVENTS.TRADE.ACCEPTED, trade);
  }

  // Emit trade rejected event
  emitTradeRejected(leagueId: number, trade: any): void {
    this.io.to(ROOM_NAMES.league(leagueId)).emit(SOCKET_EVENTS.TRADE.REJECTED, trade);
  }

  // Emit trade countered event
  emitTradeCountered(leagueId: number, data: any): void {
    this.io.to(ROOM_NAMES.league(leagueId)).emit(SOCKET_EVENTS.TRADE.COUNTERED, data);
  }

  // Emit trade cancelled event
  emitTradeCancelled(leagueId: number, trade: any): void {
    this.io.to(ROOM_NAMES.league(leagueId)).emit(SOCKET_EVENTS.TRADE.CANCELLED, trade);
  }

  // Emit trade expired event
  emitTradeExpired(leagueId: number, trade: any): void {
    this.io.to(ROOM_NAMES.league(leagueId)).emit(SOCKET_EVENTS.TRADE.EXPIRED, trade);
  }

  // Emit trade completed event (players swapped)
  emitTradeCompleted(leagueId: number, trade: any): void {
    this.io.to(ROOM_NAMES.league(leagueId)).emit(SOCKET_EVENTS.TRADE.COMPLETED, trade);
  }

  // Emit trade vetoed event
  emitTradeVetoed(leagueId: number, trade: any): void {
    this.io.to(ROOM_NAMES.league(leagueId)).emit(SOCKET_EVENTS.TRADE.VETOED, trade);
  }

  // Emit trade vote cast event
  emitTradeVoteCast(leagueId: number, data: any): void {
    this.io.to(ROOM_NAMES.league(leagueId)).emit(SOCKET_EVENTS.TRADE.VOTE_CAST, data);
  }

  // Emit trade invalidated event (player dropped)
  emitTradeInvalidated(leagueId: number, data: { tradeId: number; reason: string }): void {
    this.io.to(ROOM_NAMES.league(leagueId)).emit(SOCKET_EVENTS.TRADE.INVALIDATED, data);
  }

  // Waiver events (emitted to league room)

  // Emit waiver claim submitted event
  emitWaiverClaimSubmitted(leagueId: number, claim: any): void {
    this.io.to(ROOM_NAMES.league(leagueId)).emit(SOCKET_EVENTS.WAIVER.CLAIM_SUBMITTED, claim);
  }

  // Emit waiver claim cancelled event
  emitWaiverClaimCancelled(leagueId: number, data: { claimId: number; rosterId: number }): void {
    this.io.to(ROOM_NAMES.league(leagueId)).emit(SOCKET_EVENTS.WAIVER.CLAIM_CANCELLED, data);
  }

  // Emit waiver claim updated event
  emitWaiverClaimUpdated(leagueId: number, claim: any): void {
    this.io.to(ROOM_NAMES.league(leagueId)).emit(SOCKET_EVENTS.WAIVER.CLAIM_UPDATED, claim);
  }

  // Emit waivers processed event (batch processing complete)
  emitWaiversProcessed(leagueId: number, data: { processed: number; successful: number }): void {
    this.io.to(ROOM_NAMES.league(leagueId)).emit(SOCKET_EVENTS.WAIVER.PROCESSED, data);
  }

  // Emit waiver claim successful to specific user
  emitWaiverClaimSuccessful(userId: string, claim: any): void {
    this.emitToUser(userId, SOCKET_EVENTS.WAIVER.CLAIM_SUCCESSFUL, claim);
  }

  // Emit waiver claim failed to specific user
  emitWaiverClaimFailed(userId: string, claim: any): void {
    this.emitToUser(userId, SOCKET_EVENTS.WAIVER.CLAIM_FAILED, claim);
  }

  // Emit waiver priority updated event
  emitWaiverPriorityUpdated(leagueId: number, priorities: any[]): void {
    this.io
      .to(ROOM_NAMES.league(leagueId))
      .emit(SOCKET_EVENTS.WAIVER.PRIORITY_UPDATED, { priorities });
  }

  // Emit FAAB budget updated event
  emitWaiverBudgetUpdated(leagueId: number, budgets: any[]): void {
    this.io.to(ROOM_NAMES.league(leagueId)).emit(SOCKET_EVENTS.WAIVER.BUDGET_UPDATED, { budgets });
  }

  // Scoring events (emitted to league room)

  // Emit scores updated event (after stats sync)
  emitScoresUpdated(leagueId: number, data: { week: number; matchups: any[] }): void {
    this.io.to(ROOM_NAMES.league(leagueId)).emit(SOCKET_EVENTS.SCORING.SCORES_UPDATED, data);
  }

  // Emit week finalized event
  emitWeekFinalized(leagueId: number, data: { week: number }): void {
    this.io.to(ROOM_NAMES.league(leagueId)).emit(SOCKET_EVENTS.SCORING.WEEK_FINALIZED, data);
  }

  // Member events (emitted to league room)

  // Emit member kicked event
  emitMemberKicked(leagueId: number, data: { rosterId: number; teamName: string }): void {
    this.io.to(ROOM_NAMES.league(leagueId)).emit(SOCKET_EVENTS.MEMBER.KICKED, data);
  }

  // Emit member joined event
  emitMemberJoined(
    leagueId: number,
    data: { rosterId: number; teamName: string; userId: string }
  ): void {
    this.io.to(ROOM_NAMES.league(leagueId)).emit(SOCKET_EVENTS.MEMBER.JOINED, data);
  }

  // Playoff events (emitted to league room)

  // Emit playoff bracket generated event
  emitPlayoffBracketGenerated(leagueId: number, data: { bracketId: number }): void {
    this.io.to(ROOM_NAMES.league(leagueId)).emit(SOCKET_EVENTS.PLAYOFF.BRACKET_GENERATED, data);
  }

  // Emit playoff winners advanced event
  emitPlayoffWinnersAdvanced(leagueId: number, data: { week: number }): void {
    this.io.to(ROOM_NAMES.league(leagueId)).emit(SOCKET_EVENTS.PLAYOFF.WINNERS_ADVANCED, data);
  }

  // Emit playoff champion crowned event
  emitPlayoffChampionCrowned(
    leagueId: number,
    data: { bracketId: number; championRosterId: number }
  ): void {
    this.io.to(ROOM_NAMES.league(leagueId)).emit(SOCKET_EVENTS.PLAYOFF.CHAMPION_CROWNED, data);
  }

  getIO(): Server {
    return this.io;
  }

  /**
   * Close all socket connections and the server.
   * Returns a promise that resolves when the server is closed.
   */
  close(): Promise<void> {
    return new Promise((resolve) => {
      this.io.close(() => {
        resolve();
      });
    });
  }
}

// Singleton instance (kept for backward compatibility during migration)
let socketService: SocketService | null = null;

export function initializeSocket(httpServer: HttpServer): SocketService {
  socketService = new SocketService(httpServer);
  // Register in container for dependency injection
  container.override(KEYS.SOCKET_SERVICE, socketService);
  return socketService;
}

export function getSocketService(): SocketService {
  if (!socketService) {
    throw new Error('Socket service not initialized');
  }
  return socketService;
}

/**
 * Helper for safe optional socket access.
 * Returns null if socket is not initialized (useful during testing).
 */
export function tryGetSocketService(): SocketService | null {
  return socketService;
}

/**
 * Close the socket service and all connections.
 * Should be called during graceful shutdown.
 */
export async function closeSocket(): Promise<void> {
  if (socketService) {
    await socketService.close();
    socketService = null;
  }
}
