import { Router } from 'express';
import { WaiversController } from './waivers.controller';
import { authMiddleware } from '../../middleware/auth.middleware';
import { validateRequest } from '../../middleware/validation.middleware';
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
} from './waivers.schemas';

export function createWaiversRoutes(controller: WaiversController): Router {
  const router = Router({ mergeParams: true });

  // All routes require authentication
  router.use(authMiddleware);

  // Submit a waiver claim
  // POST /leagues/:leagueId/waivers/claims
  router.post(
    '/claims',
    validateRequest(submitClaimSchema),
    controller.submitClaim.bind(controller)
  );

  // Get user's waiver claims
  // GET /leagues/:leagueId/waivers/claims
  router.get(
    '/claims',
    validateRequest(getClaimsSchema),
    controller.getClaims.bind(controller)
  );

  // Update a waiver claim
  // PUT /leagues/:leagueId/waivers/claims/:claimId
  router.put(
    '/claims/:claimId',
    validateRequest(updateClaimSchema),
    controller.updateClaim.bind(controller)
  );

  // Cancel a waiver claim
  // DELETE /leagues/:leagueId/waivers/claims/:claimId
  router.delete(
    '/claims/:claimId',
    validateRequest(cancelClaimSchema),
    controller.cancelClaim.bind(controller)
  );

  // Get waiver priority order
  // GET /leagues/:leagueId/waivers/priority
  router.get(
    '/priority',
    validateRequest(getPrioritySchema),
    controller.getPriority.bind(controller)
  );

  // Get FAAB budgets
  // GET /leagues/:leagueId/waivers/faab
  router.get(
    '/faab',
    validateRequest(getFaabBudgetsSchema),
    controller.getFaabBudgets.bind(controller)
  );

  // Get waiver wire players
  // GET /leagues/:leagueId/waivers/wire
  router.get(
    '/wire',
    validateRequest(getWaiverWireSchema),
    controller.getWaiverWire.bind(controller)
  );

  // Initialize waiver system (commissioner only)
  // POST /leagues/:leagueId/waivers/initialize
  router.post(
    '/initialize',
    validateRequest(initializeWaiversSchema),
    controller.initializeWaivers.bind(controller)
  );

  // Manually process waivers (commissioner only)
  // POST /leagues/:leagueId/waivers/process
  router.post(
    '/process',
    validateRequest(processClaimsSchema),
    controller.processClaims.bind(controller)
  );

  return router;
}
