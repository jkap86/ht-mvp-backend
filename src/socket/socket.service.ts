import { Server as HttpServer } from 'http';
import { Server, Socket } from 'socket.io';
import { verifyToken } from '../utils/jwt';
import { env, logger } from '../config/env.config';
import { container, KEYS } from '../container';
import { LeagueRepository } from '../modules/leagues/leagues.repository';
import { DraftRepository } from '../modules/drafts/drafts.repository';
import { SOCKET_EVENTS, ROOM_NAMES } from '../constants/socket-events';

interface AuthenticatedSocket extends Socket {
  userId?: string;
  username?: string;
}

export class SocketService {
  private io: Server;

  constructor(httpServer: HttpServer) {
    // Use same CORS origin as Express (from env.FRONTEND_URL)
    const corsOrigin = env.FRONTEND_URL || 'http://localhost:3000';

    this.io = new Server(httpServer, {
      cors: {
        origin: corsOrigin,
        methods: ['GET', 'POST'],
        credentials: true,
      },
    });

    this.setupMiddleware();
    this.setupEventHandlers();
  }

  private setupMiddleware(): void {
    // Authentication middleware
    this.io.use(async (socket: AuthenticatedSocket, next) => {
      try {
        const token = socket.handshake.auth.token || socket.handshake.query.token;

        if (!token) {
          return next(new Error('Authentication required'));
        }

        const payload = verifyToken(token as string);
        socket.userId = payload.userId;
        socket.username = payload.username;
        next();
      } catch (error) {
        next(new Error('Invalid token'));
      }
    });
  }

  private setupEventHandlers(): void {
    this.io.on('connection', (socket: AuthenticatedSocket) => {
      logger.info(`Socket connected: ${socket.id} (user: ${socket.userId})`);

      // Join league room (with membership verification)
      socket.on(SOCKET_EVENTS.LEAGUE.JOIN, async (leagueId: number) => {
        if (!socket.userId) {
          socket.emit(SOCKET_EVENTS.APP.ERROR, { message: 'Not authenticated' });
          return;
        }

        try {
          const leagueRepo = container.resolve<LeagueRepository>(KEYS.LEAGUE_REPO);
          const isMember = await leagueRepo.isUserMember(leagueId, socket.userId);

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

        try {
          const draftRepo = container.resolve<DraftRepository>(KEYS.DRAFT_REPO);
          const leagueRepo = container.resolve<LeagueRepository>(KEYS.LEAGUE_REPO);

          // Get draft to find its league
          const draft = await draftRepo.findById(draftId);
          if (!draft) {
            socket.emit(SOCKET_EVENTS.APP.ERROR, { message: 'Draft not found' });
            return;
          }

          // Check if user is member of the draft's league
          const isMember = await leagueRepo.isUserMember(draft.leagueId, socket.userId);
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
      });
    });
  }

  // Emit draft pick to all users in draft room
  emitDraftPick(draftId: number, pick: any): void {
    this.io.to(ROOM_NAMES.draft(draftId)).emit(SOCKET_EVENTS.DRAFT.PICK_MADE, pick);
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

  // Emit chat message to all users in league room
  emitChatMessage(leagueId: number, message: any): void {
    this.io.to(ROOM_NAMES.league(leagueId)).emit(SOCKET_EVENTS.CHAT.MESSAGE, message);
  }

  // Emit to specific user
  emitToUser(userId: string, event: string, data: any): void {
    // Find socket by userId
    const sockets = this.io.sockets.sockets;
    for (const [, socket] of sockets) {
      const authSocket = socket as AuthenticatedSocket;
      if (authSocket.userId === userId) {
        authSocket.emit(event, data);
      }
    }
  }

  getIO(): Server {
    return this.io;
  }
}

// Singleton instance
let socketService: SocketService | null = null;

export function initializeSocket(httpServer: HttpServer): SocketService {
  socketService = new SocketService(httpServer);
  return socketService;
}

export function getSocketService(): SocketService {
  if (!socketService) {
    throw new Error('Socket service not initialized');
  }
  return socketService;
}
