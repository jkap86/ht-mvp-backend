import express from 'express';
import cors from 'cors';
import { createServer } from 'http';

import { env } from './config/env.config';
import { closePool } from './db/pool';
// Bootstrap DI container (auto-runs on import, must be before routes)
import './bootstrap';
import routes from './routes';
import { errorHandler } from './middleware/error.middleware';
import { initializeSocket } from './socket';
import { startAutopickJob, stopAutopickJob } from './jobs/autopick.job';
import { startPlayerSyncJob, stopPlayerSyncJob } from './jobs/player-sync.job';

const app = express();

// CORS configuration
const corsOptions: cors.CorsOptions = {
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, Postman)
    if (!origin) return callback(null, true);

    // In development, allow any localhost port (both localhost and 127.0.0.1)
    if (env.NODE_ENV !== 'production') {
      if (origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:')) {
        return callback(null, true);
      }
    }

    // In production, use the configured URL
    if (env.FRONTEND_URL && origin === env.FRONTEND_URL) {
      return callback(null, true);
    }

    // Reject other origins
    console.warn(`CORS rejected origin: ${origin}`);
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
};

// Middleware
app.use(cors(corsOptions));
app.use(express.json());

// Routes
app.use('/api', routes);

// Global error handler (must be last)
app.use(errorHandler);

const PORT = env.PORT;

// Create HTTP server
const server = createServer(app);

// Initialize Socket.IO
initializeSocket(server);

server.listen(PORT, () => {
  console.log(`🚀 MVP Backend running on port ${PORT}`);
  console.log(`📡 Health check: http://localhost:${PORT}/api/health`);

  // Start background jobs if enabled (for multi-instance deployments, only one instance should run jobs)
  if (env.RUN_JOBS) {
    console.log('📋 Background jobs enabled');
    startAutopickJob();
    startPlayerSyncJob(true); // Sync players from Sleeper on startup, then every 12h
  } else {
    console.log('📋 Background jobs disabled (RUN_JOBS=false)');
  }
});

// Graceful shutdown
const gracefulShutdown = () => {
  console.log('Shutting down gracefully...');

  // Stop background jobs
  stopAutopickJob();
  stopPlayerSyncJob();

  server.close(async () => {
    console.log('HTTP server closed');
    await closePool();
    process.exit(0);
  });

  // Force shutdown after 10 seconds
  setTimeout(() => {
    console.error('Forced shutdown after timeout');
    process.exit(1);
  }, 10000);
};

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  gracefulShutdown();
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
});
