import { Server as HttpServer } from 'http';
import { Server, Socket } from 'socket.io';
import { verifyToken } from '../utils/jwt';
import { logger } from '../config/env.config';

interface AuthenticatedSocket extends Socket {
  userId?: string;
  username?: string;
}

export class SocketService {
  private io: Server;

  constructor(httpServer: HttpServer) {
    this.io = new Server(httpServer, {
      cors: {
        origin: process.env.CORS_ORIGIN || '*',
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

      // Join league room
      socket.on('join:league', (leagueId: number) => {
        const room = `league:${leagueId}`;
        socket.join(room);
        logger.info(`User ${socket.userId} joined league room ${leagueId}`);
      });

      // Leave league room
      socket.on('leave:league', (leagueId: number) => {
        const room = `league:${leagueId}`;
        socket.leave(room);
        logger.info(`User ${socket.userId} left league room ${leagueId}`);
      });

      // Join draft room
      socket.on('join:draft', (draftId: number) => {
        const room = `draft:${draftId}`;
        socket.join(room);
        logger.info(`User ${socket.userId} joined draft room ${draftId}`);

        // Notify others in the draft room
        socket.to(room).emit('draft:user_joined', {
          userId: socket.userId,
          username: socket.username,
        });
      });

      // Leave draft room
      socket.on('leave:draft', (draftId: number) => {
        const room = `draft:${draftId}`;
        socket.leave(room);
        logger.info(`User ${socket.userId} left draft room ${draftId}`);

        socket.to(room).emit('draft:user_left', {
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
    this.io.to(`draft:${draftId}`).emit('draft:pick_made', pick);
  }

  // Emit draft started event
  emitDraftStarted(draftId: number, draft: any): void {
    this.io.to(`draft:${draftId}`).emit('draft:started', draft);
  }

  // Emit draft completed event
  emitDraftCompleted(draftId: number, draft: any): void {
    this.io.to(`draft:${draftId}`).emit('draft:completed', draft);
  }

  // Emit next pick info (whose turn, deadline)
  emitNextPick(draftId: number, pickInfo: any): void {
    this.io.to(`draft:${draftId}`).emit('draft:next_pick', pickInfo);
  }

  // Emit chat message to all users in league room
  emitChatMessage(leagueId: number, message: any): void {
    this.io.to(`league:${leagueId}`).emit('chat:message', message);
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
