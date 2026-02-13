import { Router } from 'express';
import { WaiversController } from './waivers.controller';
import { authMiddleware } from '../../middleware/auth.middleware';
import { validateRequest } from '../../middleware/validation.middleware';
import { apiReadLimiter, waiverLimiter } from '../../middleware/rate-limit.middleware';
import { asyncHandler } from '../../shared/async-handler';
import { resolveSeasonContext } from '../../middleware/season-context.middleware';
import { seasonWriteGuard } from '../../middleware/season-write-guard.middleware';
import {
  submitClaimSchema,
  updateClaimSchema,
  cancelClaimSchema,
  getClaimsSchema,
  getPrioritySchema,
  getFaabBudgetsSchema,
  getWaiverWireSchema,
  initializeWaiversSchema,
  processClaimsSchema,
  reorderClaimsSchema,
} from './waivers.schemas';

export function createWaiversRoutes(controller: WaiversController): Router {
  const router = Router({ mergeParams: true });

  // All routes require authentication and season context
  router.use(authMiddleware);
  router.use(resolveSeasonContext);
  router.use(seasonWriteGuard);

  // Submit a waiver claim
  // POST /leagues/:leagueId/waivers/claims
  router.post(
    '/claims',
    waiverLimiter,
    validateRequest(submitClaimSchema),
    asyncHandler(controller.submitClaim.bind(controller))
  );

  // Get user's waiver claims
  // GET /leagues/:leagueId/waivers/claims
  router.get('/claims', apiReadLimiter, validateRequest(getClaimsSchema), asyncHandler(controller.getClaims.bind(controller)));

  // Update a waiver claim
  // PUT /leagues/:leagueId/waivers/claims/:claimId
  router.put(
    '/claims/:claimId',
    waiverLimiter,
    validateRequest(updateClaimSchema),
    asyncHandler(controller.updateClaim.bind(controller))
  );

  // Cancel a waiver claim
  // DELETE /leagues/:leagueId/waivers/claims/:claimId
  router.delete(
    '/claims/:claimId',
    waiverLimiter,
    validateRequest(cancelClaimSchema),
    asyncHandler(controller.cancelClaim.bind(controller))
  );

  // Reorder waiver claims
  // PATCH /leagues/:leagueId/waivers/claims/reorder
  router.patch(
    '/claims/reorder',
    waiverLimiter,
    validateRequest(reorderClaimsSchema),
    asyncHandler(controller.reorderClaims.bind(controller))
  );

  // Get waiver priority order
  // GET /leagues/:leagueId/waivers/priority
  router.get(
    '/priority',
    apiReadLimiter,
    validateRequest(getPrioritySchema),
    asyncHandler(controller.getPriority.bind(controller))
  );

  // Get FAAB budgets
  // GET /leagues/:leagueId/waivers/faab
  router.get(
    '/faab',
    apiReadLimiter,
    validateRequest(getFaabBudgetsSchema),
    asyncHandler(controller.getFaabBudgets.bind(controller))
  );

  // Get waiver wire players
  // GET /leagues/:leagueId/waivers/wire
  router.get(
    '/wire',
    apiReadLimiter,
    validateRequest(getWaiverWireSchema),
    asyncHandler(controller.getWaiverWire.bind(controller))
  );

  // Initialize waiver system (commissioner only)
  // POST /leagues/:leagueId/waivers/initialize
  router.post(
    '/initialize',
    waiverLimiter,
    validateRequest(initializeWaiversSchema),
    asyncHandler(controller.initializeWaivers.bind(controller))
  );

  // Manually process waivers (commissioner only)
  // POST /leagues/:leagueId/waivers/process
  router.post(
    '/process',
    waiverLimiter,
    validateRequest(processClaimsSchema),
    asyncHandler(controller.processClaims.bind(controller))
  );

  return router;
}
