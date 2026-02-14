import { Router } from 'express';
import { CommissionerToolsController } from './commissioner-tools.controller';
import { CommissionerToolsService } from './commissioner-tools.service';
import { container, KEYS } from '../../container';
import { asyncHandler } from '../../shared/async-handler';
import { resolveSeasonContext } from '../../middleware/season-context.middleware';
import { seasonWriteGuard } from '../../middleware/season-write-guard.middleware';

/**
 * Creates commissioner tools routes mounted under /api/leagues/:leagueId/commissioner-tools
 */
export function createCommissionerToolsRoutes(): Router {
  const service = container.resolve<CommissionerToolsService>(KEYS.COMMISSIONER_TOOLS_SERVICE);
  const controller = new CommissionerToolsController(service);

  const router = Router({ mergeParams: true });

  const writeGuards = [resolveSeasonContext, seasonWriteGuard];

  // Draft admin
  router.patch('/drafts/:draftId/chess-clocks/:rosterId', ...writeGuards, asyncHandler(controller.adjustChessClock));
  router.post('/drafts/:draftId/force-autopick', ...writeGuards, asyncHandler(controller.forceAutopick));
  router.post('/drafts/:draftId/undo-last-pick', ...writeGuards, asyncHandler(controller.undoLastPick));

  // Waivers admin
  router.post('/waivers/reset-priority', ...writeGuards, asyncHandler(controller.resetWaiverPriority));
  router.patch('/waivers/priority/:rosterId', ...writeGuards, asyncHandler(controller.setWaiverPriority));
  router.patch('/waivers/faab/:rosterId', ...writeGuards, asyncHandler(controller.setFaabBudget));

  // Trades admin
  router.post('/trades/:tradeId/cancel', ...writeGuards, asyncHandler(controller.adminCancelTrade));
  router.patch('/settings', ...writeGuards, asyncHandler(controller.updateSettings));

  // Dues admin (GET — no write guard needed)
  router.get('/dues/export.csv', asyncHandler(controller.exportDuesCsv));

  return router;
}
