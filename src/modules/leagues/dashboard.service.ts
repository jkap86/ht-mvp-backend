import { Pool } from 'pg';
import { LeagueRepository, RosterRepository } from './leagues.repository';
import { ForbiddenException, NotFoundException } from '../../utils/exceptions';

/**
 * Dashboard summary response structure
 */
export interface DashboardSummary {
  draft: {
    id: number | null;
    status: 'scheduled' | 'live' | 'paused' | 'complete' | null;
    scheduledStart: string | null;
    currentPick: number | null;
    totalPicks: number | null;
    draftType: string | null;
  };
  auction: {
    activeLots: number;
    endingSoonCount: number;
    userLeadingCount: number;
    userOutbidCount: number;
  };
  waivers: {
    nextProcessingTime: string | null;
    userClaimsCount: number;
  };
  matchup: {
    week: number | null;
    opponentTeamName: string | null;
    opponentRosterId: number | null;
  } | null;
  pendingTrades: number;
  activeWaiverClaims: number;
  unreadChatMessages: number;
  announcements: Array<{
    id: number;
    message: string;
    createdAt: string;
  }>;
}

export class DashboardService {
  constructor(
    private readonly db: Pool,
    private readonly leagueRepo: LeagueRepository,
    private readonly rosterRepo: RosterRepository
  ) {}

  /**
   * Get dashboard summary for a league
   */
  async getDashboardSummary(leagueId: number, userId: string): Promise<DashboardSummary> {
    // Verify membership
    const roster = await this.rosterRepo.findByLeagueAndUser(leagueId, userId);
    if (!roster) {
      throw new ForbiddenException('You are not a member of this league');
    }

    const userRosterId = roster.id;

    // Run all queries in parallel for efficiency
    const [
      draftInfo,
      auctionInfo,
      waiverInfo,
      matchupInfo,
      pendingTradesCount,
      announcementRows,
    ] = await Promise.all([
      this.getDraftInfo(leagueId),
      this.getAuctionInfo(leagueId, userRosterId),
      this.getWaiverInfo(leagueId, userRosterId),
      this.getMatchupInfo(leagueId, userRosterId),
      this.getPendingTradesCount(leagueId, userRosterId),
      this.getAnnouncements(leagueId),
    ]);

    return {
      draft: draftInfo,
      auction: auctionInfo,
      waivers: waiverInfo,
      matchup: matchupInfo,
      pendingTrades: pendingTradesCount,
      activeWaiverClaims: waiverInfo.userClaimsCount,
      unreadChatMessages: 0, // TODO: implement read receipts
      announcements: announcementRows,
    };
  }


  private async getDraftInfo(leagueId: number): Promise<DashboardSummary['draft']> {
    // Get the most relevant draft (active > scheduled > most recent)
    const result = await this.db.query(
      `SELECT id, status, draft_type, scheduled_start, current_pick, rounds,
              (SELECT COUNT(*) FROM rosters WHERE league_id = $1 AND is_benched = false) as roster_count
       FROM drafts
       WHERE league_id = $1
       ORDER BY
         CASE status
           WHEN 'in_progress' THEN 1
           WHEN 'paused' THEN 2
           WHEN 'not_started' THEN 3
           ELSE 4
         END,
         created_at DESC
       LIMIT 1`,
      [leagueId]
    );

    if (result.rows.length === 0) {
      return {
        id: null,
        status: null,
        scheduledStart: null,
        currentPick: null,
        totalPicks: null,
        draftType: null,
      };
    }

    const row = result.rows[0];
    const rosterCount = parseInt(row.roster_count, 10);
    const totalPicks = row.rounds * rosterCount;

    let status: DashboardSummary['draft']['status'] = null;
    switch (row.status) {
      case 'in_progress':
        status = 'live';
        break;
      case 'paused':
        status = 'paused';
        break;
      case 'not_started':
        status = row.scheduled_start ? 'scheduled' : null;
        break;
      case 'completed':
        status = 'complete';
        break;
    }

    return {
      id: row.id,
      status,
      scheduledStart: row.scheduled_start ? row.scheduled_start.toISOString() : null,
      currentPick: row.current_pick,
      totalPicks,
      draftType: row.draft_type,
    };
  }

  private async getAuctionInfo(
    leagueId: number,
    userRosterId: number
  ): Promise<DashboardSummary['auction']> {
    // Check for active auction drafts
    const draftResult = await this.db.query(
      `SELECT id FROM drafts
       WHERE league_id = $1 AND draft_type = 'auction' AND status = 'in_progress'
       LIMIT 1`,
      [leagueId]
    );

    if (draftResult.rows.length === 0) {
      return { activeLots: 0, endingSoonCount: 0, userLeadingCount: 0, userOutbidCount: 0 };
    }

    const draftId = draftResult.rows[0].id;

    // Get auction stats
    const statsResult = await this.db.query(
      `SELECT
        COUNT(*) FILTER (WHERE status = 'active') as active_lots,
        COUNT(*) FILTER (WHERE status = 'active' AND bid_deadline < NOW() + INTERVAL '1 hour') as ending_soon,
        COUNT(*) FILTER (WHERE status = 'active' AND current_bidder_roster_id = $2) as user_leading,
        COUNT(*) FILTER (WHERE status = 'active' AND nominator_roster_id = $2 AND current_bidder_roster_id != $2) as user_outbid
       FROM auction_lots
       WHERE draft_id = $1`,
      [draftId, userRosterId]
    );

    const stats = statsResult.rows[0];
    return {
      activeLots: parseInt(stats.active_lots, 10) || 0,
      endingSoonCount: parseInt(stats.ending_soon, 10) || 0,
      userLeadingCount: parseInt(stats.user_leading, 10) || 0,
      userOutbidCount: parseInt(stats.user_outbid, 10) || 0,
    };
  }

  private async getWaiverInfo(
    leagueId: number,
    userRosterId: number
  ): Promise<DashboardSummary['waivers']> {
    // Get user's pending claims count
    const claimsResult = await this.db.query(
      `SELECT COUNT(*) as count FROM waiver_claims
       WHERE roster_id = $1 AND status = 'pending'`,
      [userRosterId]
    );

    // TODO: Calculate next processing time based on league settings
    // For now return null, actual implementation would check waiver schedule
    return {
      nextProcessingTime: null,
      userClaimsCount: parseInt(claimsResult.rows[0].count, 10) || 0,
    };
  }

  private async getMatchupInfo(
    leagueId: number,
    userRosterId: number
  ): Promise<DashboardSummary['matchup']> {
    // Get current week matchup
    const result = await this.db.query(
      `SELECT
        m.week,
        CASE
          WHEN m.roster1_id = $2 THEN m.roster2_id
          ELSE m.roster1_id
        END as opponent_roster_id,
        CASE
          WHEN m.roster1_id = $2 THEN roster2.settings->>'team_name'
          ELSE roster1.settings->>'team_name'
        END as opponent_team_name
       FROM matchups m
       JOIN leagues l ON l.id = m.league_id
       LEFT JOIN rosters roster1 ON roster1.id = m.roster1_id
       LEFT JOIN rosters roster2 ON roster2.id = m.roster2_id
       WHERE m.league_id = $1
         AND m.week = l.current_week
         AND (m.roster1_id = $2 OR m.roster2_id = $2)
       LIMIT 1`,
      [leagueId, userRosterId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0];
    return {
      week: row.week,
      opponentTeamName: row.opponent_team_name || `Team ${row.opponent_roster_id}`,
      opponentRosterId: row.opponent_roster_id,
    };
  }

  private async getPendingTradesCount(leagueId: number, userRosterId: number): Promise<number> {
    const result = await this.db.query(
      `SELECT COUNT(*) as count FROM trades
       WHERE league_id = $1
         AND status = 'pending'
         AND recipient_roster_id = $2`,
      [leagueId, userRosterId]
    );
    return parseInt(result.rows[0].count, 10) || 0;
  }

  private async getAnnouncements(
    leagueId: number
  ): Promise<DashboardSummary['announcements']> {
    // Get latest commissioner messages (system messages about settings changes)
    const result = await this.db.query(
      `SELECT id, message, created_at as "createdAt"
       FROM league_chat_messages
       WHERE league_id = $1
         AND message_type = 'settings_updated'
       ORDER BY id DESC
       LIMIT 3`,
      [leagueId]
    );

    return result.rows.map((row) => ({
      id: row.id,
      message: row.message,
      createdAt: row.createdAt.toISOString(),
    }));
  }

}
