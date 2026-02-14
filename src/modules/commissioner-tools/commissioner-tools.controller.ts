import { Response } from 'express';
import { AuthRequest } from '../../middleware/auth.middleware';
import { CommissionerToolsService } from './commissioner-tools.service';
import { ValidationException } from '../../utils/exceptions';
import { requireUserId, requireLeagueId } from '../../utils/controller-helpers';
import { parseIntParam } from '../../utils/params';
import {
  adjustChessClockSchema,
  setWaiverPrioritySchema,
  setFaabBudgetSchema,
  adminCancelTradeSchema,
  updateCommissionerSettingsSchema,
} from './commissioner-tools.schemas';

export class CommissionerToolsController {
  constructor(private readonly service: CommissionerToolsService) {}

  // ── Draft: Adjust Chess Clock ──────────────────────────────────

  adjustChessClock = async (req: AuthRequest, res: Response) => {
    const userId = requireUserId(req);
    const leagueId = requireLeagueId(req);
    const draftId = parseIntParam(req.params.draftId);
    const rosterId = parseIntParam(req.params.rosterId);

    if (isNaN(draftId)) throw new ValidationException('Invalid draft ID');
    if (isNaN(rosterId)) throw new ValidationException('Invalid roster ID');

    const parsed = adjustChessClockSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationException(parsed.error.issues[0].message);
    }

    const clockMap = await this.service.adjustChessClock(
      leagueId,
      draftId,
      rosterId,
      parsed.data.delta_seconds,
      userId
    );

    res.status(200).json({ chess_clocks: clockMap });
  };

  // ── Draft: Force Autopick ──────────────────────────────────────

  forceAutopick = async (req: AuthRequest, res: Response) => {
    const userId = requireUserId(req);
    const leagueId = requireLeagueId(req);
    const draftId = parseIntParam(req.params.draftId);

    if (isNaN(draftId)) throw new ValidationException('Invalid draft ID');

    await this.service.forceAutopick(leagueId, draftId, userId);

    res.status(200).json({ message: 'Autopick completed' });
  };

  // ── Draft: Undo Last Pick ─────────────────────────────────────

  undoLastPick = async (req: AuthRequest, res: Response) => {
    const userId = requireUserId(req);
    const leagueId = requireLeagueId(req);
    const draftId = parseIntParam(req.params.draftId);

    if (isNaN(draftId)) throw new ValidationException('Invalid draft ID');

    const result = await this.service.undoLastPick(leagueId, draftId, userId);

    res.status(200).json(result);
  };

  // ── Waivers: Reset Priority ───────────────────────────────────

  resetWaiverPriority = async (req: AuthRequest, res: Response) => {
    const userId = requireUserId(req);
    const leagueId = requireLeagueId(req);

    await this.service.resetWaiverPriority(leagueId, userId);

    res.status(200).json({ message: 'Waiver priority reset' });
  };

  // ── Waivers: Set Priority ─────────────────────────────────────

  setWaiverPriority = async (req: AuthRequest, res: Response) => {
    const userId = requireUserId(req);
    const leagueId = requireLeagueId(req);
    const rosterId = parseIntParam(req.params.rosterId);

    if (isNaN(rosterId)) throw new ValidationException('Invalid roster ID');

    const parsed = setWaiverPrioritySchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationException(parsed.error.issues[0].message);
    }

    await this.service.setWaiverPriority(leagueId, rosterId, parsed.data.priority, userId);

    res.status(200).json({ message: 'Waiver priority updated' });
  };

  // ── Waivers: Set FAAB Budget ──────────────────────────────────

  setFaabBudget = async (req: AuthRequest, res: Response) => {
    const userId = requireUserId(req);
    const leagueId = requireLeagueId(req);
    const rosterId = parseIntParam(req.params.rosterId);

    if (isNaN(rosterId)) throw new ValidationException('Invalid roster ID');

    const parsed = setFaabBudgetSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationException(parsed.error.issues[0].message);
    }

    await this.service.setFaabBudget(leagueId, rosterId, parsed.data.set_to, userId);

    res.status(200).json({ message: 'FAAB budget updated' });
  };

  // ── Trades: Admin Cancel ──────────────────────────────────────

  adminCancelTrade = async (req: AuthRequest, res: Response) => {
    const userId = requireUserId(req);
    const leagueId = requireLeagueId(req);
    const tradeId = parseIntParam(req.params.tradeId);

    if (isNaN(tradeId)) throw new ValidationException('Invalid trade ID');

    const parsed = adminCancelTradeSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationException(parsed.error.issues[0].message);
    }

    await this.service.adminCancelTrade(leagueId, tradeId, userId, parsed.data?.reason);

    res.status(200).json({ message: 'Trade cancelled by commissioner' });
  };

  // ── Trades: Update Settings ───────────────────────────────────

  updateSettings = async (req: AuthRequest, res: Response) => {
    const userId = requireUserId(req);
    const leagueId = requireLeagueId(req);

    const parsed = updateCommissionerSettingsSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationException(parsed.error.issues[0].message);
    }

    await this.service.updateTradingLocked(leagueId, parsed.data.trading_locked, userId);

    res.status(200).json({ message: 'Settings updated' });
  };

  // ── Dues: Export CSV ──────────────────────────────────────────

  exportDuesCsv = async (req: AuthRequest, res: Response) => {
    const userId = requireUserId(req);
    const leagueId = requireLeagueId(req);
    const leagueSeasonId = req.leagueSeasonId;

    const csv = await this.service.exportDuesCsv(leagueId, userId, leagueSeasonId);

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="dues-${leagueId}.csv"`);
    res.status(200).send(csv);
  };
}
