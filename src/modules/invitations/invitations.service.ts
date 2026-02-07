import { InvitationsRepository } from './invitations.repository';
import { LeagueRepository, RosterRepository } from '../leagues/leagues.repository';
import { UserRepository } from '../auth/auth.repository';
import { RosterService } from '../leagues/roster.service';
import { EventTypes, tryGetEventBus } from '../../shared/events';
import {
  InvitationWithDetails,
  UserSearchResult,
  invitationWithDetailsToResponse,
} from './invitations.model';
import {
  NotFoundException,
  ForbiddenException,
  ConflictException,
  ValidationException,
} from '../../utils/exceptions';

export class InvitationsService {
  constructor(
    private readonly invitationsRepo: InvitationsRepository,
    private readonly leagueRepo: LeagueRepository,
    private readonly rosterRepo: RosterRepository,
    private readonly userRepo: UserRepository,
    private readonly rosterService: RosterService
  ) {}

  /**
   * Send an invitation to a user (any league member can invite)
   */
  async sendInvitation(
    leagueId: number,
    username: string,
    invitedByUserId: string,
    message?: string
  ): Promise<InvitationWithDetails> {
    // Verify sender is a league member
    const isMember = await this.leagueRepo.isUserMember(leagueId, invitedByUserId);
    if (!isMember) {
      throw new ForbiddenException('Only league members can send invitations');
    }

    // Get league to check capacity
    const league = await this.leagueRepo.findById(leagueId);
    if (!league) {
      throw new NotFoundException('League not found');
    }

    // Look up user by username
    const invitedUser = await this.userRepo.findByUsername(username);
    if (!invitedUser) {
      throw new NotFoundException(`User '${username}' not found`);
    }

    // Prevent inviting yourself
    if (invitedUser.userId === invitedByUserId) {
      throw new ValidationException('You cannot invite yourself');
    }

    // Check if user is already a member
    const invitedUserIsMember = await this.leagueRepo.isUserMember(leagueId, invitedUser.userId);
    if (invitedUserIsMember) {
      throw new ConflictException(`${username} is already a member of this league`);
    }

    // Check if user already has a pending invite
    const hasPendingInvite = await this.invitationsRepo.hasPendingInvite(
      leagueId,
      invitedUser.userId
    );
    if (hasPendingInvite) {
      throw new ConflictException(`${username} already has a pending invitation`);
    }

    // Check if league is full
    const memberCount = await this.rosterRepo.getRosterCount(leagueId);
    if (memberCount >= league.totalRosters) {
      throw new ConflictException('League is full');
    }

    // Create invitation
    const invitation = await this.invitationsRepo.create({
      leagueId,
      invitedUserId: invitedUser.userId,
      invitedByUserId,
      message,
    });

    // Get full invitation details
    const invitationWithDetails = await this.invitationsRepo.findByIdWithDetails(invitation.id);
    if (!invitationWithDetails) {
      throw new Error('Failed to retrieve invitation details');
    }

    // Emit event to invited user
    const eventBus = tryGetEventBus();
    eventBus?.publish({
      type: EventTypes.INVITATION_RECEIVED,
      userId: invitedUser.userId,
      payload: invitationWithDetailsToResponse(invitationWithDetails),
    });

    return invitationWithDetails;
  }

  /**
   * Get pending invitations for the current user
   */
  async getMyPendingInvitations(userId: string): Promise<InvitationWithDetails[]> {
    return this.invitationsRepo.findPendingByUserId(userId);
  }

  /**
   * Accept an invitation and join the league
   */
  async acceptInvitation(invitationId: number, userId: string): Promise<any> {
    // Get invitation
    const invitation = await this.invitationsRepo.findById(invitationId);
    if (!invitation) {
      throw new NotFoundException('Invitation not found');
    }

    // Verify invitation belongs to this user
    if (invitation.invitedUserId !== userId) {
      throw new ForbiddenException('This invitation was not sent to you');
    }

    // Check invitation is still pending
    if (invitation.status !== 'pending') {
      throw new ValidationException(`Invitation has already been ${invitation.status}`);
    }

    // Check not expired
    if (new Date() > invitation.expiresAt) {
      await this.invitationsRepo.updateStatus(invitationId, 'declined');
      throw new ValidationException('Invitation has expired');
    }

    // Mark accepted FIRST (conditional - only if still pending)
    // This prevents race conditions where two accepts could succeed
    const updated = await this.invitationsRepo.updateStatusConditional(
      invitationId,
      'accepted',
      'pending'
    );
    if (!updated) {
      throw new ConflictException('Invitation already processed');
    }

    try {
      // Join the league via roster service
      const result = await this.rosterService.joinLeague(invitation.leagueId, userId);

      // Get full league details to return
      const league = await this.leagueRepo.findByIdWithUserRoster(invitation.leagueId, userId);

      return {
        message: result.message,
        league: league?.toResponse(),
      };
    } catch (error) {
      // Revert invitation status on join failure
      await this.invitationsRepo.revertToPending(invitationId);
      throw error;
    }
  }

  /**
   * Decline an invitation
   */
  async declineInvitation(invitationId: number, userId: string): Promise<void> {
    // Get invitation
    const invitation = await this.invitationsRepo.findByIdWithDetails(invitationId);
    if (!invitation) {
      throw new NotFoundException('Invitation not found');
    }

    // Verify invitation belongs to this user
    if (invitation.invitedUserId !== userId) {
      throw new ForbiddenException('This invitation was not sent to you');
    }

    // Check invitation is still pending
    if (invitation.status !== 'pending') {
      throw new ValidationException(`Invitation has already been ${invitation.status}`);
    }

    // Update status
    await this.invitationsRepo.updateStatus(invitationId, 'declined');

    // Notify the commissioner who sent the invite
    const eventBus = tryGetEventBus();
    eventBus?.publish({
      type: EventTypes.INVITATION_DECLINED,
      userId: invitation.invitedByUserId,
      payload: {
        invitationId,
        leagueId: invitation.leagueId,
        leagueName: invitation.leagueName,
      },
    });
  }

  /**
   * Cancel a pending invitation (commissioner only)
   */
  async cancelInvitation(invitationId: number, userId: string): Promise<void> {
    // Get invitation
    const invitation = await this.invitationsRepo.findById(invitationId);
    if (!invitation) {
      throw new NotFoundException('Invitation not found');
    }

    // Verify user is commissioner of this league
    const isCommissioner = await this.leagueRepo.isCommissioner(invitation.leagueId, userId);
    if (!isCommissioner) {
      throw new ForbiddenException('Only the commissioner can cancel invitations');
    }

    // Check invitation is still pending
    if (invitation.status !== 'pending') {
      throw new ValidationException(`Invitation has already been ${invitation.status}`);
    }

    // Delete the invitation
    await this.invitationsRepo.delete(invitationId);

    // Notify the invited user
    const eventBus = tryGetEventBus();
    eventBus?.publish({
      type: EventTypes.INVITATION_CANCELLED,
      userId: invitation.invitedUserId,
      payload: {
        invitationId,
        leagueId: invitation.leagueId,
      },
    });
  }

  /**
   * Get pending invitations for a league (any league member can view)
   */
  async getLeaguePendingInvitations(leagueId: number, userId: string): Promise<any[]> {
    // Verify user is a league member
    const isMember = await this.leagueRepo.isUserMember(leagueId, userId);
    if (!isMember) {
      throw new ForbiddenException('Only league members can view league invitations');
    }

    const invitations = await this.invitationsRepo.findByLeagueId(leagueId);
    return invitations.map((inv) => ({
      ...invitationWithDetailsToResponse(inv),
      invited_username: (inv as any).invitedUsername,
    }));
  }

  /**
   * Search users for inviting (any league member can search)
   */
  async searchUsersForInvite(
    leagueId: number,
    query: string,
    userId: string
  ): Promise<UserSearchResult[]> {
    // Verify user is a league member
    const isMember = await this.leagueRepo.isUserMember(leagueId, userId);
    if (!isMember) {
      throw new ForbiddenException('Only league members can search for users to invite');
    }

    if (!query || query.trim().length < 2) {
      throw new ValidationException('Search query must be at least 2 characters');
    }

    return this.invitationsRepo.searchUsersForInvite(leagueId, query.trim());
  }
}
