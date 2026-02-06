import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { createServer } from 'http';

import { env } from './config/env.config';
import { logger } from './config/logger.config';
import { closePool } from './db/pool';
import { closeRedis } from './config/redis.config';
import { requestTimingMiddleware } from './middleware/request-timing.middleware';
import { requestIdMiddleware } from './middleware/request-id.middleware';
// Bootstrap DI container (auto-runs on import, must be before routes)
import './bootstrap';
import routes from './routes';
import { errorHandler } from './middleware/error.middleware';
import { initializeSocket, closeSocket } from './socket';
import { startAutopickJob, stopAutopickJob } from './jobs/autopick.job';
import { startDerbyJob, stopDerbyJob } from './jobs/derby.job';
import { startPlayerSyncJob, stopPlayerSyncJob } from './jobs/player-sync.job';
import { startSlowAuctionJob, stopSlowAuctionJob } from './jobs/slow-auction.job';
import { startTradeExpirationJob, stopTradeExpirationJob } from './jobs/trade-expiration.job';
import { startWaiverProcessingJob, stopWaiverProcessingJob } from './jobs/waiver-processing.job';

const app = express();

// Trust proxy for correct IP detection behind load balancers/proxies
// Required for rate limiting and security features to work correctly
app.set('trust proxy', 1);

// CORS configuration
const corsOptions: cors.CorsOptions = {
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, Postman)
    if (!origin) return callback(null, true);

    // In development, allow localhost, 127.0.0.1, Android emulator, and specific development IPs
    if (env.NODE_ENV !== 'production') {
      // Allowed development origins - update with your specific dev machine IPs
      const allowedDevOrigins = [
        'http://localhost',
        'http://127.0.0.1',
        'http://10.0.2.2', // Android emulator host
        // Add your specific development machine IPs here (not entire networks):
        // 'http://192.168.1.100',
        // 'http://172.16.0.50',
      ];

      // Check if origin starts with any allowed prefix (for different ports)
      const isAllowed = allowedDevOrigins.some((allowed) => origin.startsWith(`${allowed}:`));

      if (isAllowed) {
        return callback(null, true);
      }
    }

    // In production, use the configured URL
    if (env.FRONTEND_URL && origin === env.FRONTEND_URL) {
      return callback(null, true);
    }

    // Reject other origins
    logger.warn('CORS rejected origin', { origin });
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
};

// Middleware
app.use(
  helmet({
    // Disable contentSecurityPolicy for API server (no HTML served)
    contentSecurityPolicy: false,
    // Enable all other security headers
    crossOriginEmbedderPolicy: false, // Allow embedding from mobile apps
    hidePoweredBy: true, // Explicitly hide X-Powered-By header
  })
);
app.use(cors(corsOptions));
app.use(express.json({ limit: '10kb' })); // Limit payload size to prevent DoS
app.use(requestIdMiddleware); // Add request ID for distributed tracing
app.use(requestTimingMiddleware);

// Routes
app.use('/api', routes);

// Global error handler (must be last)
app.use(errorHandler);

const PORT = env.PORT;

// Create HTTP server
const server = createServer(app);

// Initialize Socket.IO
initializeSocket(server);

server.listen(PORT, '0.0.0.0', () => {
  logger.info('MVP Backend started', { port: PORT, healthCheck: `http://localhost:${PORT}/api/health` });

  // Start background jobs if enabled (for multi-instance deployments, only one instance should run jobs)
  if (env.RUN_JOBS) {
    logger.info('Background jobs enabled');
    startAutopickJob();
    startDerbyJob();
    startSlowAuctionJob();
    startTradeExpirationJob();
    startWaiverProcessingJob();
    startPlayerSyncJob(true); // Sync players from Sleeper on startup, then every 12h
  } else {
    logger.info('Background jobs disabled', { reason: 'RUN_JOBS=false' });
  }
});

// Graceful shutdown
const gracefulShutdown = () => {
  logger.info('Shutting down gracefully...');

  // Stop background jobs
  stopAutopickJob();
  stopDerbyJob();
  stopSlowAuctionJob();
  stopTradeExpirationJob();
  stopWaiverProcessingJob();
  stopPlayerSyncJob();

  server.close(async () => {
    logger.info('HTTP server closed');
    await closeSocket();
    logger.info('Socket.IO closed');
    await closeRedis();
    await closePool();
    process.exit(0);
  });

  // Force shutdown after 10 seconds
  setTimeout(() => {
    logger.error('Forced shutdown after timeout');
    process.exit(1);
  }, 10000);
};

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception', { error: error.message, stack: error.stack });
  gracefulShutdown();
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled Rejection', { reason: String(reason) });
  gracefulShutdown();
});
