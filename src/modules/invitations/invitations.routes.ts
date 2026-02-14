import { Router } from 'express';
import { InvitationsController } from './invitations.controller';
import { authMiddleware } from '../../middleware/auth.middleware';
import { container, KEYS } from '../../container';
import { InvitationsService } from './invitations.service';
import { apiReadLimiter, tradeLimiter, searchLimiter } from '../../middleware/rate-limit.middleware';
import { asyncHandler } from '../../shared/async-handler';
import { idempotencyMiddleware } from '../../middleware/idempotency.middleware';
import { Pool } from 'pg';

// Resolve dependencies from container
const invitationsService = container.resolve<InvitationsService>(KEYS.INVITATIONS_SERVICE);
const invitationsController = new InvitationsController(invitationsService);

const router = Router();

// All invitation routes require authentication
router.use(authMiddleware);
router.use(idempotencyMiddleware(container.resolve<Pool>(KEYS.POOL)));

// GET /api/invitations/pending - Get my pending invitations
router.get('/pending', apiReadLimiter, asyncHandler(invitationsController.getMyInvitations));

// POST /api/invitations/:id/accept - Accept invitation
router.post('/:id/accept', tradeLimiter, asyncHandler(invitationsController.acceptInvitation));

// POST /api/invitations/:id/decline - Decline invitation
router.post('/:id/decline', tradeLimiter, asyncHandler(invitationsController.declineInvitation));

// DELETE /api/invitations/:id - Cancel invitation (commissioner only)
router.delete('/:id', tradeLimiter, asyncHandler(invitationsController.cancelInvitation));

export default router;

/**
 * Creates invitation routes that are mounted under /api/leagues/:leagueId/invitations
 * These routes need access to leagueId from params
 */
export function createLeagueInvitationRoutes(): Router {
  const leagueRouter = Router({ mergeParams: true });

  // POST /api/leagues/:leagueId/invitations - Send invitation (commissioner only)
  leagueRouter.post('/', tradeLimiter, asyncHandler(invitationsController.sendInvitation));

  // GET /api/leagues/:leagueId/invitations - Get league invitations (commissioner only)
  leagueRouter.get('/', apiReadLimiter, asyncHandler(invitationsController.getLeagueInvitations));

  return leagueRouter;
}

/**
 * Creates user search route that is mounted under /api/leagues/:leagueId/users
 */
export function createUserSearchRoutes(): Router {
  const searchRouter = Router({ mergeParams: true });

  // GET /api/leagues/:leagueId/users/search?q=query - Search users for inviting
  searchRouter.get('/search', searchLimiter, asyncHandler(invitationsController.searchUsersForInvite));

  return searchRouter;
}
