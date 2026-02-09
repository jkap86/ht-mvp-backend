import { Router } from 'express';
import { InvitationsController } from './invitations.controller';
import { authMiddleware } from '../../middleware/auth.middleware';
import { container, KEYS } from '../../container';
import { InvitationsService } from './invitations.service';
import { apiReadLimiter, tradeLimiter, searchLimiter } from '../../middleware/rate-limit.middleware';

// Resolve dependencies from container
const invitationsService = container.resolve<InvitationsService>(KEYS.INVITATIONS_SERVICE);
const invitationsController = new InvitationsController(invitationsService);

const router = Router();

// All invitation routes require authentication
router.use(authMiddleware);

// GET /api/invitations/pending - Get my pending invitations
router.get('/pending', apiReadLimiter, invitationsController.getMyInvitations);

// POST /api/invitations/:id/accept - Accept invitation
router.post('/:id/accept', tradeLimiter, invitationsController.acceptInvitation);

// POST /api/invitations/:id/decline - Decline invitation
router.post('/:id/decline', tradeLimiter, invitationsController.declineInvitation);

// DELETE /api/invitations/:id - Cancel invitation (commissioner only)
router.delete('/:id', tradeLimiter, invitationsController.cancelInvitation);

export default router;

/**
 * Creates invitation routes that are mounted under /api/leagues/:leagueId/invitations
 * These routes need access to leagueId from params
 */
export function createLeagueInvitationRoutes(): Router {
  const leagueRouter = Router({ mergeParams: true });

  // POST /api/leagues/:leagueId/invitations - Send invitation (commissioner only)
  leagueRouter.post('/', tradeLimiter, invitationsController.sendInvitation);

  // GET /api/leagues/:leagueId/invitations - Get league invitations (commissioner only)
  leagueRouter.get('/', apiReadLimiter, invitationsController.getLeagueInvitations);

  return leagueRouter;
}

/**
 * Creates user search route that is mounted under /api/leagues/:leagueId/users
 */
export function createUserSearchRoutes(): Router {
  const searchRouter = Router({ mergeParams: true });

  // GET /api/leagues/:leagueId/users/search?q=query - Search users for inviting
  searchRouter.get('/search', searchLimiter, invitationsController.searchUsersForInvite);

  return searchRouter;
}
