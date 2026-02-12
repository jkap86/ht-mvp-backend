import { Router } from 'express';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { authMiddleware } from '../../middleware/auth.middleware';
import { validateRequest } from '../../middleware/validation.middleware';
import { authLimiter, refreshTokenLimiter, searchLimiter } from '../../middleware/rate-limit.middleware';
import { registerSchema, loginSchema, refreshTokenSchema } from './auth.schemas';
import { container, KEYS } from '../../container';
import { asyncHandler } from '../../shared/async-handler';

// Resolve dependencies from container
const authService = container.resolve<AuthService>(KEYS.AUTH_SERVICE);
const authController = new AuthController(authService);

const router = Router();

// POST /api/auth/register
router.post(
  '/register',
  authLimiter,
  validateRequest(registerSchema, 'body'),
  asyncHandler(authController.register)
);

// POST /api/auth/login
router.post('/login', authLimiter, validateRequest(loginSchema, 'body'), asyncHandler(authController.login));

// POST /api/auth/refresh
router.post(
  '/refresh',
  refreshTokenLimiter,
  validateRequest(refreshTokenSchema, 'body'),
  asyncHandler(authController.refresh)
);

// GET /api/auth/me (protected)
router.get('/me', authMiddleware, asyncHandler(authController.me));

// POST /api/auth/logout (protected)
router.post('/logout', authMiddleware, asyncHandler(authController.logout));

// GET /api/auth/users/search?q=<query> (protected, rate limited)
router.get('/users/search', authMiddleware, searchLimiter, asyncHandler(authController.searchUsers));

export default router;
