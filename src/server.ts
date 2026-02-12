import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { createServer } from 'http';

import { env } from './config/env.config';
import { logger } from './config/logger.config';
import { isAllowedOrigin, isAllowedDevOrigin } from './config/cors.config';
import { closePool } from './db/pool';
import { closeRedis } from './config/redis.config';
import { requestTimingMiddleware } from './middleware/request-timing.middleware';
import { requestIdMiddleware } from './middleware/request-id.middleware';
import { poolHealthMiddleware } from './middleware/pool-health.middleware';
// Bootstrap DI container (auto-runs on import, must be before routes)
import './bootstrap';
import routes from './routes';
import { errorHandler } from './middleware/error.middleware';
import { initializeSocket, closeSocket } from './socket';
import { cleanupRateLimitIntervals } from './middleware/socket-rate-limit.middleware';
import { startAutopickJob, stopAutopickJob } from './jobs/autopick.job';
import { startDerbyJob, stopDerbyJob } from './jobs/derby.job';
import { startPlayerSyncJob, stopPlayerSyncJob } from './jobs/player-sync.job';
import { startSlowAuctionJob, stopSlowAuctionJob } from './jobs/slow-auction.job';
import { startTradeExpirationJob, stopTradeExpirationJob } from './jobs/trade-expiration.job';
import { startWaiverProcessingJob, stopWaiverProcessingJob } from './jobs/waiver-processing.job';
import { startStatsSyncJob, stopStatsSyncJob } from './jobs/stats-sync.job';
import { startIdempotencyCleanupJob, stopIdempotencyCleanupJob } from './jobs/idempotency-cleanup.job';
import { Pool } from 'pg';
import { container, KEYS } from './container';

const app = express();

// Trust proxy for correct IP detection behind load balancers/proxies
// Required for rate limiting and security features to work correctly
app.set('trust proxy', 1);

// CORS configuration
const corsOptions: cors.CorsOptions = {
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, Postman)
    if (!origin) return callback(null, true);

    // In development, allow common dev origins
    if (env.NODE_ENV !== 'production' && isAllowedDevOrigin(origin)) {
      return callback(null, true);
    }

    // Check against production allowlist (FRONTEND_URL + FRONTEND_URLS)
    if (isAllowedOrigin(origin)) {
      return callback(null, true);
    }

    // Reject other origins
    logger.warn('CORS rejected origin', { origin });
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-idempotency-key'],
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
app.use(express.json({ limit: '50kb' })); // Limit payload size to prevent DoS
app.use(requestIdMiddleware); // Add request ID for distributed tracing
app.use(requestTimingMiddleware);
app.use(poolHealthMiddleware); // Circuit breaker: reject requests when pool is exhausted

// Routes
app.use('/api', routes);

// Global error handler (must be last)
app.use(errorHandler);

const PORT = env.PORT;

// Create HTTP server
const server = createServer(app);

// Initialize server with async Socket.IO setup
(async () => {
  try {
    // Initialize Socket.IO (async for Redis adapter connection)
    await initializeSocket(server);

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
        startStatsSyncJob(true); // Sync stats from Sleeper on startup, then dynamically
        startIdempotencyCleanupJob();
      } else {
        logger.info('Background jobs disabled', { reason: 'RUN_JOBS=false' });
      }
    });
  } catch (error) {
    logger.error('Failed to initialize server', { error });
    process.exit(1);
  }
})();

// Graceful shutdown
let isShuttingDown = false;
const gracefulShutdown = () => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  logger.info('Shutting down gracefully...');

  // Stop background jobs
  stopAutopickJob();
  stopDerbyJob();
  stopSlowAuctionJob();
  stopTradeExpirationJob();
  stopWaiverProcessingJob();
  stopPlayerSyncJob();
  stopStatsSyncJob();
  stopIdempotencyCleanupJob();

  // Cleanup rate limit intervals
  cleanupRateLimitIntervals();

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
