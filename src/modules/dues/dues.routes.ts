import { Router } from 'express';
import { DuesController } from './dues.controller';
import { DuesService } from './dues.service';
import { container, KEYS } from '../../container';

/**
 * Creates dues routes that are mounted under /api/leagues/:leagueId/dues
 * These routes need access to leagueId from params
 */
export function createDuesRoutes(): Router {
  // Resolve dependencies from container
  const duesService = container.resolve<DuesService>(KEYS.DUES_SERVICE);
  const duesController = new DuesController(duesService);

  const router = Router({ mergeParams: true });

  // GET /api/leagues/:leagueId/dues - Get dues overview
  router.get('/', duesController.getDuesOverview);

  // PUT /api/leagues/:leagueId/dues - Create/update dues config
  router.put('/', duesController.upsertDuesConfig);

  // DELETE /api/leagues/:leagueId/dues - Delete dues config
  router.delete('/', duesController.deleteDuesConfig);

  // GET /api/leagues/:leagueId/dues/payments - Get all payment statuses
  router.get('/payments', duesController.getPaymentStatuses);

  // PATCH /api/leagues/:leagueId/dues/payments/:rosterId - Mark payment status
  router.patch('/payments/:rosterId', duesController.markPaymentStatus);

  return router;
}
