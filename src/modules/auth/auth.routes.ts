import { Router } from 'express';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { authMiddleware } from '../../middleware/auth.middleware';
import { validateRequest } from '../../middleware/validation.middleware';
import { authLimiter, refreshTokenLimiter, searchLimiter } from '../../middleware/rate-limit.middleware';
import { registerSchema, loginSchema, refreshTokenSchema } from './auth.schemas';
import { container, KEYS } from '../../container';

// Resolve dependencies from container
const authService = container.resolve<AuthService>(KEYS.AUTH_SERVICE);
const authController = new AuthController(authService);

const router = Router();

// POST /api/auth/register
router.post(
  '/register',
  authLimiter,
  validateRequest(registerSchema, 'body'),
  authController.register
);

// POST /api/auth/login
router.post('/login', authLimiter, validateRequest(loginSchema, 'body'), authController.login);

// POST /api/auth/refresh
router.post(
  '/refresh',
  refreshTokenLimiter,
  validateRequest(refreshTokenSchema, 'body'),
  authController.refresh
);

// GET /api/auth/me (protected)
router.get('/me', authMiddleware, authController.me);

// POST /api/auth/logout (protected)
router.post('/logout', authMiddleware, authController.logout);

// GET /api/auth/users/search?q=<query> (protected, rate limited)
router.get('/users/search', authMiddleware, searchLimiter, authController.searchUsers);

export default router;
