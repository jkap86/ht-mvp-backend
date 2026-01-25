import { Response, NextFunction } from 'express';
import { AuthRequest } from '../../middleware/auth.middleware';
import { WaiversService } from './waivers.service';
import { LeagueRepository, RosterRepository } from '../leagues/leagues.repository';
import {
  waiverClaimToResponse,
  waiverPriorityToResponse,
  faabBudgetToResponse,
} from './waivers.model';
import { ForbiddenException, NotFoundException } from '../../utils/exceptions';
import { requireUserId, requireLeagueId } from '../../utils/controller-helpers';

export class WaiversController {
  constructor(
    private readonly waiversService: WaiversService,
    private readonly leagueRepo: LeagueRepository,
    private readonly rosterRepo: RosterRepository
  ) {}

  /**
   * Submit a waiver claim
   * POST /leagues/:leagueId/waivers/claims
   */
  submitClaim = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const leagueId = requireLeagueId(req);
      const userId = requireUserId(req);
      const { player_id, drop_player_id, bid_amount } = req.body;

      const claim = await this.waiversService.submitClaim(leagueId, userId, {
        playerId: player_id,
        dropPlayerId: drop_player_id || null,
        bidAmount: bid_amount || 0,
      });

      res.status(201).json(waiverClaimToResponse(claim));
    } catch (error) {
      next(error);
    }
  };

  /**
   * Get user's waiver claims
   * GET /leagues/:leagueId/waivers/claims
   */
  getClaims = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const leagueId = requireLeagueId(req);
      const userId = requireUserId(req);

      const claims = await this.waiversService.getMyClaims(leagueId, userId);

      res.status(200).json({
        claims: claims.map(waiverClaimToResponse),
      });
    } catch (error) {
      next(error);
    }
  };

  /**
   * Update a waiver claim
   * PUT /leagues/:leagueId/waivers/claims/:claimId
   */
  updateClaim = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const claimId = parseInt(req.params.claimId as string, 10);
      const userId = requireUserId(req);
      const { drop_player_id, bid_amount } = req.body;

      const claim = await this.waiversService.updateClaim(claimId, userId, {
        dropPlayerId: drop_player_id,
        bidAmount: bid_amount,
      });

      res.status(200).json(waiverClaimToResponse(claim));
    } catch (error) {
      next(error);
    }
  };

  /**
   * Cancel a waiver claim
   * DELETE /leagues/:leagueId/waivers/claims/:claimId
   */
  cancelClaim = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const claimId = parseInt(req.params.claimId as string, 10);
      const userId = requireUserId(req);

      await this.waiversService.cancelClaim(claimId, userId);

      res.status(200).json({ success: true });
    } catch (error) {
      next(error);
    }
  };

  /**
   * Get waiver priority order
   * GET /leagues/:leagueId/waivers/priority
   */
  getPriority = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const leagueId = requireLeagueId(req);
      const userId = requireUserId(req);

      const priorities = await this.waiversService.getPriorityOrder(leagueId, userId);

      res.status(200).json({
        priorities: priorities.map(waiverPriorityToResponse),
      });
    } catch (error) {
      next(error);
    }
  };

  /**
   * Get FAAB budgets
   * GET /leagues/:leagueId/waivers/faab
   */
  getFaabBudgets = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const leagueId = requireLeagueId(req);
      const userId = requireUserId(req);

      const budgets = await this.waiversService.getFaabBudgets(leagueId, userId);

      res.status(200).json({
        budgets: budgets.map(faabBudgetToResponse),
      });
    } catch (error) {
      next(error);
    }
  };

  /**
   * Get waiver wire players
   * GET /leagues/:leagueId/waivers/wire
   */
  getWaiverWire = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const leagueId = requireLeagueId(req);
      const userId = requireUserId(req);

      // Verify user is in league
      const roster = await this.rosterRepo.findByLeagueAndUser(leagueId, userId);
      if (!roster) {
        throw new ForbiddenException('You are not a member of this league');
      }

      const players = await this.waiversService.getWaiverWirePlayers(leagueId);

      res.status(200).json({
        players,
      });
    } catch (error) {
      next(error);
    }
  };

  /**
   * Initialize waiver system for league (commissioner only)
   * POST /leagues/:leagueId/waivers/initialize
   */
  initializeWaivers = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const leagueId = requireLeagueId(req);
      const userId = requireUserId(req);

      // Verify user is commissioner
      const roster = await this.rosterRepo.findByLeagueAndUser(leagueId, userId);
      if (!roster) {
        throw new ForbiddenException('You are not a member of this league');
      }

      const league = await this.leagueRepo.findById(leagueId);
      if (!league) {
        throw new NotFoundException('League not found');
      }

      if (league.commissionerRosterId !== roster.id) {
        throw new ForbiddenException('Only the commissioner can initialize waivers');
      }

      await this.waiversService.initializeForSeason(leagueId, parseInt(league.season, 10));

      res.status(200).json({ success: true, message: 'Waivers initialized' });
    } catch (error) {
      next(error);
    }
  };

  /**
   * Manually trigger waiver processing (commissioner/admin only)
   * POST /leagues/:leagueId/waivers/process
   */
  processClaims = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const leagueId = requireLeagueId(req);
      const userId = requireUserId(req);

      // Verify user is commissioner
      const roster = await this.rosterRepo.findByLeagueAndUser(leagueId, userId);
      if (!roster) {
        throw new ForbiddenException('You are not a member of this league');
      }

      const league = await this.leagueRepo.findById(leagueId);
      if (!league) {
        throw new NotFoundException('League not found');
      }

      if (league.commissionerRosterId !== roster.id) {
        throw new ForbiddenException('Only the commissioner can manually process waivers');
      }

      const result = await this.waiversService.processLeagueClaims(leagueId);

      res.status(200).json({
        success: true,
        processed: result.processed,
        successful: result.successful,
      });
    } catch (error) {
      next(error);
    }
  };
}
