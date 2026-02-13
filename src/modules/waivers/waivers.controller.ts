import { Response } from 'express';
import { AuthRequest } from '../../middleware/auth.middleware';
import { WaiversService } from './waivers.service';
import { AuthorizationService } from '../auth/authorization.service';
import {
  waiverClaimToResponse,
  waiverPriorityToResponse,
  faabBudgetToResponse,
  waiverWirePlayerToResponse,
} from './waivers.model';
import { requireUserId, requireLeagueId, requireLeagueSeasonId } from '../../utils/controller-helpers';

export class WaiversController {
  constructor(
    private readonly waiversService: WaiversService,
    private readonly authService: AuthorizationService
  ) {}

  submitClaim = async (req: AuthRequest, res: Response): Promise<void> => {
    const leagueId = requireLeagueId(req);
    const userId = requireUserId(req);
    const leagueSeasonId = req.leagueSeasonId;
    const { player_id, drop_player_id, bid_amount } = req.body;
    const idempotencyKey = req.headers['x-idempotency-key'] as string | undefined;

    const claim = await this.waiversService.submitClaim(
      leagueId,
      userId,
      {
        playerId: player_id,
        dropPlayerId: drop_player_id || null,
        bidAmount: bid_amount || 0,
      },
      idempotencyKey,
      leagueSeasonId
    );

    res.status(201).json(waiverClaimToResponse(claim));
  };

  getClaims = async (req: AuthRequest, res: Response): Promise<void> => {
    const leagueId = requireLeagueId(req);
    const userId = requireUserId(req);

    const claims = await this.waiversService.getMyClaims(leagueId, userId);

    res.status(200).json({
      claims: claims.map(waiverClaimToResponse),
    });
  };

  updateClaim = async (req: AuthRequest, res: Response): Promise<void> => {
    const claimId = parseInt(req.params.claimId as string, 10);
    const userId = requireUserId(req);
    const { drop_player_id, bid_amount } = req.body;

    const claim = await this.waiversService.updateClaim(claimId, userId, {
      dropPlayerId: drop_player_id,
      bidAmount: bid_amount,
    });

    res.status(200).json(waiverClaimToResponse(claim));
  };

  cancelClaim = async (req: AuthRequest, res: Response): Promise<void> => {
    const claimId = parseInt(req.params.claimId as string, 10);
    const userId = requireUserId(req);

    await this.waiversService.cancelClaim(claimId, userId);

    res.status(200).json({ success: true });
  };

  getPriority = async (req: AuthRequest, res: Response): Promise<void> => {
    const leagueId = requireLeagueId(req);
    const userId = requireUserId(req);
    const leagueSeasonId = req.leagueSeasonId;

    const priorities = await this.waiversService.getPriorityOrder(leagueId, userId, leagueSeasonId);

    res.status(200).json({
      priorities: priorities.map(waiverPriorityToResponse),
    });
  };

  getFaabBudgets = async (req: AuthRequest, res: Response): Promise<void> => {
    const leagueId = requireLeagueId(req);
    const userId = requireUserId(req);

    const budgets = await this.waiversService.getFaabBudgets(leagueId, userId);

    res.status(200).json({
      budgets: budgets.map(faabBudgetToResponse),
    });
  };

  getWaiverWire = async (req: AuthRequest, res: Response): Promise<void> => {
    const leagueId = requireLeagueId(req);
    const userId = requireUserId(req);
    const leagueSeasonId = req.leagueSeasonId;

    // Verify user is in league
    await this.authService.ensureLeagueMember(leagueId, userId);

    const players = await this.waiversService.getWaiverWirePlayers(leagueId, leagueSeasonId);

    res.status(200).json({
      players: players.map(waiverWirePlayerToResponse),
    });
  };

  initializeWaivers = async (req: AuthRequest, res: Response): Promise<void> => {
    const leagueId = requireLeagueId(req);
    const userId = requireUserId(req);

    // Verify user is commissioner
    await this.authService.ensureCommissioner(leagueId, userId);

    await this.waiversService.initializeForSeason(leagueId);

    res.status(200).json({ success: true, message: 'Waivers initialized' });
  };

  processClaims = async (req: AuthRequest, res: Response): Promise<void> => {
    const leagueId = requireLeagueId(req);
    const userId = requireUserId(req);

    // Verify user is commissioner
    await this.authService.ensureCommissioner(leagueId, userId);

    const result = await this.waiversService.processLeagueClaims(leagueId);

    res.status(200).json({
      success: true,
      processed: result.processed,
      successful: result.successful,
    });
  };

  reorderClaims = async (req: AuthRequest, res: Response): Promise<void> => {
    const leagueId = requireLeagueId(req);
    const userId = requireUserId(req);
    const { claim_ids } = req.body;

    const claims = await this.waiversService.reorderClaims(leagueId, userId, claim_ids);

    res.status(200).json({
      claims: claims.map(waiverClaimToResponse),
    });
  };
}
