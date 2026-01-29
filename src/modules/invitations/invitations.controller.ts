import { Response, NextFunction } from 'express';
import { AuthRequest } from '../../middleware/auth.middleware';
import { InvitationsService } from './invitations.service';
import { ValidationException } from '../../utils/exceptions';
import { requireUserId, requireLeagueId } from '../../utils/controller-helpers';
import { invitationWithDetailsToResponse } from './invitations.model';

export class InvitationsController {
  constructor(private readonly invitationsService: InvitationsService) {}

  /**
   * GET /api/invitations/pending
   * Get pending invitations for the current user
   */
  getMyInvitations = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = requireUserId(req);

      const invitations = await this.invitationsService.getMyPendingInvitations(userId);
      res.status(200).json(invitations.map(invitationWithDetailsToResponse));
    } catch (error) {
      next(error);
    }
  };

  /**
   * POST /api/invitations/:id/accept
   * Accept an invitation and join the league
   */
  acceptInvitation = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = requireUserId(req);
      const invitationId = parseInt(req.params.id as string, 10);

      if (isNaN(invitationId)) {
        throw new ValidationException('Invalid invitation ID');
      }

      const result = await this.invitationsService.acceptInvitation(invitationId, userId);
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  };

  /**
   * POST /api/invitations/:id/decline
   * Decline an invitation
   */
  declineInvitation = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = requireUserId(req);
      const invitationId = parseInt(req.params.id as string, 10);

      if (isNaN(invitationId)) {
        throw new ValidationException('Invalid invitation ID');
      }

      await this.invitationsService.declineInvitation(invitationId, userId);
      res.status(200).json({ message: 'Invitation declined' });
    } catch (error) {
      next(error);
    }
  };

  /**
   * DELETE /api/invitations/:id
   * Cancel an invitation (commissioner only)
   */
  cancelInvitation = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = requireUserId(req);
      const invitationId = parseInt(req.params.id as string, 10);

      if (isNaN(invitationId)) {
        throw new ValidationException('Invalid invitation ID');
      }

      await this.invitationsService.cancelInvitation(invitationId, userId);
      res.status(200).json({ message: 'Invitation cancelled' });
    } catch (error) {
      next(error);
    }
  };

  /**
   * POST /api/leagues/:leagueId/invitations
   * Send an invitation (commissioner only)
   */
  sendInvitation = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = requireUserId(req);
      const leagueId = requireLeagueId(req);

      const { username, message } = req.body;

      if (!username || typeof username !== 'string' || username.trim().length === 0) {
        throw new ValidationException('Username is required');
      }

      const invitation = await this.invitationsService.sendInvitation(
        leagueId,
        username.trim(),
        userId,
        message?.trim() || undefined
      );

      res.status(201).json(invitationWithDetailsToResponse(invitation));
    } catch (error) {
      next(error);
    }
  };

  /**
   * GET /api/leagues/:leagueId/invitations
   * Get pending invitations for a league (commissioner only)
   */
  getLeagueInvitations = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = requireUserId(req);
      const leagueId = requireLeagueId(req);

      const invitations = await this.invitationsService.getLeaguePendingInvitations(
        leagueId,
        userId
      );
      res.status(200).json(invitations);
    } catch (error) {
      next(error);
    }
  };

  /**
   * GET /api/leagues/:leagueId/users/search?q=query
   * Search users for inviting (commissioner only)
   */
  searchUsersForInvite = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = requireUserId(req);
      const leagueId = requireLeagueId(req);

      const query = req.query.q as string;

      if (!query || query.trim().length < 2) {
        throw new ValidationException('Search query must be at least 2 characters');
      }

      const users = await this.invitationsService.searchUsersForInvite(leagueId, query, userId);
      res.status(200).json(
        users.map((u) => ({
          id: u.id,
          username: u.username,
          has_pending_invite: u.hasPendingInvite,
          is_member: u.isMember,
        }))
      );
    } catch (error) {
      next(error);
    }
  };
}
