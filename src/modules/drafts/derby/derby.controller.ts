/**
 * Derby Controller
 *
 * Handles HTTP endpoints for derby draft order mode.
 */

import { Response, NextFunction } from 'express';
import { AuthRequest } from '../../../middleware/auth.middleware';
import { DerbyService } from './derby.service';
import {
  requireUserId,
  requireLeagueId,
  requireDraftId,
} from '../../../utils/controller-helpers';
import { ValidationException } from '../../../utils/exceptions';

export class DerbyController {
  constructor(private readonly derbyService: DerbyService) {}

  /**
   * Start derby phase for a draft.
   * POST /api/leagues/:leagueId/drafts/:draftId/derby/start
   */
  startDerby = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = requireUserId(req);
      const leagueId = requireLeagueId(req);
      const draftId = requireDraftId(req);

      const state = await this.derbyService.startDerby(leagueId, draftId, userId);
      res.status(200).json(state);
    } catch (error) {
      next(error);
    }
  };

  /**
   * Pick a slot during derby phase.
   * POST /api/leagues/:leagueId/drafts/:draftId/derby/pick-slot
   */
  pickSlot = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = requireUserId(req);
      const leagueId = requireLeagueId(req);
      const draftId = requireDraftId(req);

      const { slot_number } = req.body;
      if (typeof slot_number !== 'number' || !Number.isInteger(slot_number)) {
        throw new ValidationException('slot_number must be an integer');
      }

      await this.derbyService.pickSlot(leagueId, draftId, userId, slot_number);
      res.status(200).json({ success: true });
    } catch (error) {
      next(error);
    }
  };

  /**
   * Get current derby state.
   * GET /api/leagues/:leagueId/drafts/:draftId/derby/state
   */
  getDerbyState = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = requireUserId(req);
      const leagueId = requireLeagueId(req);
      const draftId = requireDraftId(req);

      const state = await this.derbyService.getDerbyState(leagueId, draftId, userId);
      res.status(200).json(state);
    } catch (error) {
      next(error);
    }
  };
}
