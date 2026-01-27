import { Pool } from 'pg';
import {
  LeagueInvitation,
  InvitationWithDetails,
  UserSearchResult,
  invitationFromDatabase,
  invitationWithDetailsFromDatabase,
} from './invitations.model';

export interface CreateInvitationParams {
  leagueId: number;
  invitedUserId: string;
  invitedByUserId: string;
  message?: string;
}

export class InvitationsRepository {
  constructor(private readonly db: Pool) {}

  async create(params: CreateInvitationParams): Promise<LeagueInvitation> {
    const result = await this.db.query(
      `INSERT INTO league_invitations (league_id, invited_user_id, invited_by_user_id, message)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [params.leagueId, params.invitedUserId, params.invitedByUserId, params.message || null]
    );

    return invitationFromDatabase(result.rows[0]);
  }

  async findById(id: number): Promise<LeagueInvitation | null> {
    const result = await this.db.query(
      'SELECT * FROM league_invitations WHERE id = $1',
      [id]
    );

    if (result.rows.length === 0) return null;
    return invitationFromDatabase(result.rows[0]);
  }

  async findByIdWithDetails(id: number): Promise<InvitationWithDetails | null> {
    const result = await this.db.query(
      `SELECT
        li.*,
        l.name as league_name,
        l.season as league_season,
        l.mode as league_mode,
        l.total_rosters,
        u.username as invited_by_username,
        (SELECT COUNT(*) FROM rosters r WHERE r.league_id = l.id) as member_count
       FROM league_invitations li
       INNER JOIN leagues l ON li.league_id = l.id
       INNER JOIN users u ON li.invited_by_user_id = u.id
       WHERE li.id = $1`,
      [id]
    );

    if (result.rows.length === 0) return null;
    return invitationWithDetailsFromDatabase(result.rows[0]);
  }

  async findPendingByUserId(userId: string): Promise<InvitationWithDetails[]> {
    const result = await this.db.query(
      `SELECT
        li.*,
        l.name as league_name,
        l.season as league_season,
        l.mode as league_mode,
        l.total_rosters,
        u.username as invited_by_username,
        (SELECT COUNT(*) FROM rosters r WHERE r.league_id = l.id) as member_count
       FROM league_invitations li
       INNER JOIN leagues l ON li.league_id = l.id
       INNER JOIN users u ON li.invited_by_user_id = u.id
       WHERE li.invited_user_id = $1
         AND li.status = 'pending'
         AND li.expires_at > CURRENT_TIMESTAMP
       ORDER BY li.created_at DESC`,
      [userId]
    );

    return result.rows.map(invitationWithDetailsFromDatabase);
  }

  async findByLeagueId(leagueId: number): Promise<InvitationWithDetails[]> {
    const result = await this.db.query(
      `SELECT
        li.*,
        l.name as league_name,
        l.season as league_season,
        l.mode as league_mode,
        l.total_rosters,
        inviter.username as invited_by_username,
        invitee.username as invited_username,
        (SELECT COUNT(*) FROM rosters r WHERE r.league_id = l.id) as member_count
       FROM league_invitations li
       INNER JOIN leagues l ON li.league_id = l.id
       INNER JOIN users inviter ON li.invited_by_user_id = inviter.id
       INNER JOIN users invitee ON li.invited_user_id = invitee.id
       WHERE li.league_id = $1
       ORDER BY li.created_at DESC`,
      [leagueId]
    );

    return result.rows.map(row => ({
      ...invitationWithDetailsFromDatabase(row),
      invitedUsername: row.invited_username,
    }));
  }

  async hasPendingInvite(leagueId: number, userId: string): Promise<boolean> {
    const result = await this.db.query(
      `SELECT EXISTS(
        SELECT 1 FROM league_invitations
        WHERE league_id = $1
          AND invited_user_id = $2
          AND status = 'pending'
          AND expires_at > CURRENT_TIMESTAMP
      )`,
      [leagueId, userId]
    );
    return result.rows[0].exists;
  }

  async updateStatus(
    id: number,
    status: 'accepted' | 'declined'
  ): Promise<LeagueInvitation | null> {
    const result = await this.db.query(
      `UPDATE league_invitations
       SET status = $2, responded_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING *`,
      [id, status]
    );

    if (result.rows.length === 0) return null;
    return invitationFromDatabase(result.rows[0]);
  }

  async delete(id: number): Promise<boolean> {
    const result = await this.db.query(
      'DELETE FROM league_invitations WHERE id = $1',
      [id]
    );
    return result.rowCount !== null && result.rowCount > 0;
  }

  async expireOldInvitations(): Promise<number> {
    const result = await this.db.query(
      `UPDATE league_invitations
       SET status = 'expired'
       WHERE status = 'pending' AND expires_at <= CURRENT_TIMESTAMP`
    );
    return result.rowCount || 0;
  }

  async searchUsersForInvite(
    leagueId: number,
    query: string,
    limit: number = 10
  ): Promise<UserSearchResult[]> {
    const searchQuery = `%${query}%`;
    const result = await this.db.query(
      `SELECT
        u.id,
        u.username,
        EXISTS(
          SELECT 1 FROM league_invitations li
          WHERE li.league_id = $1
            AND li.invited_user_id = u.id
            AND li.status = 'pending'
            AND li.expires_at > CURRENT_TIMESTAMP
        ) as has_pending_invite,
        EXISTS(
          SELECT 1 FROM rosters r
          WHERE r.league_id = $1 AND r.user_id = u.id
        ) as is_member
       FROM users u
       WHERE u.username ILIKE $2
       ORDER BY u.username
       LIMIT $3`,
      [leagueId, searchQuery, limit]
    );

    return result.rows.map(row => ({
      id: row.id,
      username: row.username,
      hasPendingInvite: row.has_pending_invite,
      isMember: row.is_member,
    }));
  }
}
