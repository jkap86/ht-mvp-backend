import { Router } from 'express';
import authRoutes from '../modules/auth/auth.routes';
import leagueRoutes from '../modules/leagues/leagues.routes';
import playerRoutes from '../modules/players/players.routes';

const router = Router();

// Health check
router.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Auth routes
router.use('/auth', authRoutes);

// League routes
router.use('/leagues', leagueRoutes);

// Player routes
router.use('/players', playerRoutes);

export default router;
