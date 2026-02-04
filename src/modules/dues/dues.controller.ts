import { Response, NextFunction } from 'express';
import { AuthRequest } from '../../middleware/auth.middleware';
import { DuesService } from './dues.service';
import { ValidationException } from '../../utils/exceptions';
import { requireUserId, requireLeagueId } from '../../utils/controller-helpers';
import { parseIntParam } from '../../utils/params';
import {
  leagueDuesToResponse,
  duesPaymentToResponse,
  duesPaymentWithRosterToResponse,
} from './dues.model';
import { upsertDuesConfigSchema, markPaymentSchema } from './dues.schemas';

export class DuesController {
  constructor(private readonly duesService: DuesService) {}

  /**
   * GET /api/leagues/:leagueId/dues
   * Get dues overview (config + payment statuses + summary)
   */
  getDuesOverview = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = requireUserId(req);
      const leagueId = requireLeagueId(req);

      const overview = await this.duesService.getDuesOverview(leagueId, userId);

      res.status(200).json({
        config: overview.config ? leagueDuesToResponse(overview.config) : null,
        payments: overview.payments.map(duesPaymentWithRosterToResponse),
        summary: overview.summary,
        payouts: overview.payouts,
      });
    } catch (error) {
      next(error);
    }
  };

  /**
   * PUT /api/leagues/:leagueId/dues
   * Create or update dues configuration (commissioner only)
   */
  upsertDuesConfig = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = requireUserId(req);
      const leagueId = requireLeagueId(req);

      const parsed = upsertDuesConfigSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationException(parsed.error.issues[0].message);
      }

      const input = {
        buyInAmount: parsed.data.buy_in_amount,
        payoutStructure: parsed.data.payout_structure,
        currency: parsed.data.currency,
        notes: parsed.data.notes,
      };

      const config = await this.duesService.upsertDuesConfig(leagueId, userId, input);
      res.status(200).json(leagueDuesToResponse(config));
    } catch (error) {
      next(error);
    }
  };

  /**
   * DELETE /api/leagues/:leagueId/dues
   * Delete dues configuration (commissioner only)
   */
  deleteDuesConfig = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = requireUserId(req);
      const leagueId = requireLeagueId(req);

      await this.duesService.deleteDuesConfig(leagueId, userId);
      res.status(200).json({ message: 'Dues configuration deleted' });
    } catch (error) {
      next(error);
    }
  };

  /**
   * GET /api/leagues/:leagueId/dues/payments
   * Get all payment statuses
   */
  getPaymentStatuses = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = requireUserId(req);
      const leagueId = requireLeagueId(req);

      const payments = await this.duesService.getPaymentStatuses(leagueId, userId);
      res.status(200).json(payments.map(duesPaymentWithRosterToResponse));
    } catch (error) {
      next(error);
    }
  };

  /**
   * PATCH /api/leagues/:leagueId/dues/payments/:rosterId
   * Mark payment status (commissioner only)
   */
  markPaymentStatus = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = requireUserId(req);
      const leagueId = requireLeagueId(req);
      const rosterId = parseIntParam(req.params.rosterId);

      if (isNaN(rosterId)) {
        throw new ValidationException('Invalid roster ID');
      }

      const parsed = markPaymentSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationException(parsed.error.issues[0].message);
      }

      const payment = await this.duesService.markPaymentStatus(
        leagueId,
        rosterId,
        userId,
        parsed.data.is_paid,
        parsed.data.notes
      );

      res.status(200).json(duesPaymentToResponse(payment));
    } catch (error) {
      next(error);
    }
  };
}
