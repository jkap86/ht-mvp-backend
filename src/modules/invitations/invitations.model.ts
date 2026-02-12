/**
 * League invitation domain model
 */

export type InvitationStatus = 'pending' | 'accepted' | 'declined' | 'expired';

export interface LeagueInvitation {
  id: number;
  leagueId: number;
  invitedUserId: string;
  invitedByUserId: string;
  status: InvitationStatus;
  message: string | null;
  createdAt: Date;
  updatedAt: Date;
  respondedAt: Date | null;
  expiresAt: Date;
}

export interface InvitationWithDetails extends LeagueInvitation {
  leagueName: string;
  leagueSeason: string;
  leagueMode: string;
  invitedByUsername: string;
  memberCount: number;
  totalRosters: number;
}

export interface UserSearchResult {
  id: string;
  username: string;
  hasPendingInvite: boolean;
  isMember: boolean;
}

export function invitationFromDatabase(row: any): LeagueInvitation {
  return {
    id: row.id,
    leagueId: row.league_id,
    invitedUserId: row.invited_user_id,
    invitedByUserId: row.invited_by_user_id,
    status: row.status,
    message: row.message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    respondedAt: row.responded_at,
    expiresAt: row.expires_at,
  };
}

export function invitationWithDetailsFromDatabase(row: any): InvitationWithDetails {
  return {
    ...invitationFromDatabase(row),
    leagueName: row.league_name,
    leagueSeason: row.league_season,
    leagueMode: row.league_mode || 'redraft',
    invitedByUsername: row.invited_by_username,
    memberCount: Number(row.member_count) || 0,
    totalRosters: row.total_rosters,
  };
}

export function invitationToResponse(invitation: LeagueInvitation) {
  return {
    id: invitation.id,
    league_id: invitation.leagueId,
    invited_user_id: invitation.invitedUserId,
    invited_by_user_id: invitation.invitedByUserId,
    status: invitation.status,
    message: invitation.message,
    created_at: invitation.createdAt,
    updated_at: invitation.updatedAt,
    responded_at: invitation.respondedAt,
    expires_at: invitation.expiresAt,
  };
}

export function invitationWithDetailsToResponse(invitation: InvitationWithDetails) {
  return {
    ...invitationToResponse(invitation),
    league_name: invitation.leagueName,
    league_season: invitation.leagueSeason,
    league_mode: invitation.leagueMode,
    invited_by_username: invitation.invitedByUsername,
    member_count: invitation.memberCount,
    total_rosters: invitation.totalRosters,
  };
}
