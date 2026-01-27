import { Router } from 'express';
import authRoutes from '../modules/auth/auth.routes';
import leagueRoutes from '../modules/leagues/leagues.routes';
import playerRoutes from '../modules/players/players.routes';
import invitationRoutes from '../modules/invitations/invitations.routes';
import { pool, getPoolMetrics } from '../db/pool';
import { metrics } from '../services/metrics.service';
import { checkRedisHealth } from '../config/redis.config';

const router = Router();

// Health check
router.get('/health', async (req, res) => {
  let dbHealthy = true;
  try {
    await pool.query('SELECT 1');
  } catch {
    dbHealthy = false;
  }

  const redisHealthy = process.env.REDIS_HOST ? await checkRedisHealth() : true;
  const poolMetrics = getPoolMetrics();
  const isHealthy = dbHealthy && redisHealthy;

  res.status(isHealthy ? 200 : 503).json({
    status: isHealthy ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
    database: dbHealthy ? 'ok' : 'error',
    redis: process.env.REDIS_HOST ? (redisHealthy ? 'ok' : 'error') : 'disabled',
    pool: poolMetrics,
  });
});

// Metrics endpoint
router.get('/metrics', (req, res) => {
  res.json({
    timestamp: new Date().toISOString(),
    ...metrics.getMetrics(),
    pool: getPoolMetrics(),
  });
});

// Auth routes
router.use('/auth', authRoutes);

// League routes
router.use('/leagues', leagueRoutes);

// Player routes
router.use('/players', playerRoutes);

// Invitation routes (top-level for user's invitations)
router.use('/invitations', invitationRoutes);

export default router;
