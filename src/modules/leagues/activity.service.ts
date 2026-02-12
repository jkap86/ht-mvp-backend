/**
 * Activity Feed Service
 * Stream D: Transaction Activity Feed (D1.1)
 * Aggregates transactions from multiple sources into unified feed
 */

import { Pool, PoolClient } from 'pg';
import { logger } from '../../config/logger.config';

export type ActivityType = 'trade' | 'waiver' | 'add' | 'drop' | 'draft';

export interface ActivityItem {
  id: string; // Composite ID: type:id
  type: ActivityType;
  timestamp: Date;
  leagueId: number;
  week?: number;
  season?: string;
  // Type-specific data (discriminated union)
  data: TradeActivity | WaiverActivity | AddDropActivity | DraftActivity;
}

export interface TradeActivity {
  tradeId: number;
  status: string;
  proposerRosterId: number;
  proposerTeamName: string;
  recipientRosterId: number;
  recipientTeamName: string;
  playerCount: number; // Total players involved
  pickCount: number; // Total picks involved
}

export interface WaiverActivity {
  claimId: number;
  rosterId: number;
  teamName: string;
  playerAdded: { id: number; name: string; position: string; team: string };
  playerDropped?: { id: number; name: string; position: string; team: string };
  bidAmount?: number; // FAAB bid
  priority?: number; // Waiver priority at time of claim
  successful: boolean;
}

export interface AddDropActivity {
  transactionId: number;
  rosterId: number;
  teamName: string;
  player: { id: number; name: string; position: string; team: string };
  isAdd: boolean; // true = add, false = drop
}

export interface DraftActivity {
  pickId: number;
  pickNumber: number;
  round: number;
  rosterId: number;
  teamName: string;
  player: { id: number; name: string; position: string; team: string };
  isAutoPick: boolean;
}

export class ActivityService {
  constructor(private readonly db: Pool) {}

  /**
   * Get activity feed for a league
   * Combines trades, waivers, adds/drops, and draft picks
   */
  async getLeagueActivity(
    leagueId: number,
    options: {
      type?: ActivityType | 'all';
      limit?: number;
      offset?: number;
      week?: number;
    } = {}
  ): Promise<ActivityItem[]> {
    const { type = 'all', limit = 50, offset = 0, week } = options;

    const activities: ActivityItem[] = [];

    // Fetch from each source based on type filter
    if (type === 'all' || type === 'trade') {
      const trades = await this.getTradeActivities(leagueId, week, limit, offset);
      activities.push(...trades);
    }

    if (type === 'all' || type === 'waiver') {
      const waivers = await this.getWaiverActivities(leagueId, week, limit, offset);
      activities.push(...waivers);
    }

    if (type === 'all' || type === 'add' || type === 'drop') {
      const addDrops = await this.getAddDropActivities(leagueId, week, limit, offset, type);
      activities.push(...addDrops);
    }

    if (type === 'all' || type === 'draft') {
      const draftPicks = await this.getDraftActivities(leagueId, limit, offset);
      activities.push(...draftPicks);
    }

    // Sort by timestamp DESC and apply limit
    activities.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

    return activities.slice(0, limit);
  }

  /**
   * Get activity for a specific roster (team)
   */
  async getRosterActivity(
    rosterId: number,
    limit = 50,
    offset = 0
  ): Promise<ActivityItem[]> {
    // Similar to league activity but filtered by roster_id
    // Implementation would query same tables with roster_id filter
    // For brevity, placeholder:
    logger.info(`Getting activity for roster ${rosterId}`);
    return [];
  }

  /**
   * Get trade activities
   */
  private async getTradeActivities(
    leagueId: number,
    week?: number,
    limit = 50,
    offset = 0
  ): Promise<ActivityItem[]> {
    const query = `
      SELECT
        t.id as trade_id,
        t.status,
        t.proposer_roster_id,
        t.recipient_roster_id,
        t.created_at,
        t.completed_at,
        r1.roster_id as proposer_roster_num,
        r1.settings->>'team_name' as proposer_team_name,
        r2.roster_id as recipient_roster_num,
        r2.settings->>'team_name' as recipient_team_name,
        (SELECT COUNT(*) FROM trade_items WHERE trade_id = t.id) as item_count
      FROM trades t
      JOIN rosters r1 ON r1.id = t.proposer_roster_id
      JOIN rosters r2 ON r2.id = t.recipient_roster_id
      WHERE t.league_id = $1
        AND t.status IN ('completed', 'accepted')
        ${week ? 'AND EXTRACT(WEEK FROM t.completed_at) = $2' : ''}
      ORDER BY t.completed_at DESC
      LIMIT $${week ? '3' : '2'} OFFSET $${week ? '4' : '3'}
    `;

    const params = week ? [leagueId, week, limit, offset] : [leagueId, limit, offset];
    const result = await this.db.query(query, params);

    return result.rows.map((row) => ({
      id: `trade:${row.trade_id}`,
      type: 'trade' as ActivityType,
      timestamp: new Date(row.completed_at || row.created_at),
      leagueId,
      data: {
        tradeId: row.trade_id,
        status: row.status,
        proposerRosterId: row.proposer_roster_num,
        proposerTeamName: row.proposer_team_name || `Team ${row.proposer_roster_num}`,
        recipientRosterId: row.recipient_roster_num,
        recipientTeamName: row.recipient_team_name || `Team ${row.recipient_roster_num}`,
        playerCount: Number(row.item_count) || 0,
        pickCount: 0, // TODO: Calculate from trade_items
      },
    }));
  }

  /**
   * Get waiver claim activities
   */
  private async getWaiverActivities(
    leagueId: number,
    week?: number,
    limit = 50,
    offset = 0
  ): Promise<ActivityItem[]> {
    const query = `
      SELECT
        wc.id as claim_id,
        wc.roster_id,
        wc.player_id,
        wc.drop_player_id,
        wc.bid_amount,
        wc.priority_at_claim,
        wc.status,
        wc.processed_at,
        r.settings->>'team_name' as team_name,
        p1.full_name as player_name,
        p1.position as player_position,
        p1.team as player_team,
        p2.full_name as drop_player_name,
        p2.position as drop_player_position,
        p2.team as drop_player_team
      FROM waiver_claims wc
      JOIN rosters r ON r.roster_id = wc.roster_id AND r.league_id = wc.league_id
      JOIN players p1 ON p1.id = wc.player_id
      LEFT JOIN players p2 ON p2.id = wc.drop_player_id
      WHERE wc.league_id = $1
        AND wc.status IN ('successful', 'processed')
        ${week ? 'AND wc.week = $2' : ''}
      ORDER BY wc.processed_at DESC
      LIMIT $${week ? '3' : '2'} OFFSET $${week ? '4' : '3'}
    `;

    const params = week ? [leagueId, week, limit, offset] : [leagueId, limit, offset];
    const result = await this.db.query(query, params);

    return result.rows.map((row) => ({
      id: `waiver:${row.claim_id}`,
      type: 'waiver' as ActivityType,
      timestamp: new Date(row.processed_at),
      leagueId,
      week: week,
      data: {
        claimId: row.claim_id,
        rosterId: row.roster_id,
        teamName: row.team_name || `Team ${row.roster_id}`,
        playerAdded: {
          id: row.player_id,
          name: row.player_name,
          position: row.player_position,
          team: row.player_team,
        },
        playerDropped: row.drop_player_id
          ? {
              id: row.drop_player_id,
              name: row.drop_player_name,
              position: row.drop_player_position,
              team: row.drop_player_team,
            }
          : undefined,
        bidAmount: row.bid_amount ? parseFloat(row.bid_amount) : undefined,
        priority: row.priority_at_claim,
        successful: row.status === 'successful',
      },
    }));
  }

  /**
   * Get add/drop transaction activities
   */
  private async getAddDropActivities(
    leagueId: number,
    week?: number,
    limit = 50,
    offset = 0,
    type?: 'add' | 'drop' | 'all'
  ): Promise<ActivityItem[]> {
    const typeFilter =
      type === 'add'
        ? "AND rt.transaction_type = 'add'"
        : type === 'drop'
        ? "AND rt.transaction_type = 'drop'"
        : "AND rt.transaction_type IN ('add', 'drop')";

    const query = `
      SELECT
        rt.id as transaction_id,
        rt.roster_id,
        rt.player_id,
        rt.transaction_type,
        rt.created_at,
        rt.week,
        r.settings->>'team_name' as team_name,
        p.full_name as player_name,
        p.position as player_position,
        p.team as player_team
      FROM roster_transactions rt
      JOIN rosters r ON r.roster_id = rt.roster_id
      JOIN players p ON p.id = rt.player_id
      WHERE r.league_id = $1
        ${typeFilter}
        ${week ? 'AND rt.week = $2' : ''}
      ORDER BY rt.created_at DESC
      LIMIT $${week ? '3' : '2'} OFFSET $${week ? '4' : '3'}
    `;

    const params = week ? [leagueId, week, limit, offset] : [leagueId, limit, offset];
    const result = await this.db.query(query, params);

    return result.rows.map((row) => ({
      id: `${row.transaction_type}:${row.transaction_id}`,
      type: row.transaction_type as ActivityType,
      timestamp: new Date(row.created_at),
      leagueId,
      week: row.week,
      data: {
        transactionId: row.transaction_id,
        rosterId: row.roster_id,
        teamName: row.team_name || `Team ${row.roster_id}`,
        player: {
          id: row.player_id,
          name: row.player_name,
          position: row.player_position,
          team: row.player_team,
        },
        isAdd: row.transaction_type === 'add',
      },
    }));
  }

  /**
   * Get draft pick activities
   */
  private async getDraftActivities(
    leagueId: number,
    limit = 50,
    offset = 0
  ): Promise<ActivityItem[]> {
    const query = `
      SELECT
        dp.id as pick_id,
        dp.pick_number,
        dp.round,
        dp.roster_id,
        dp.player_id,
        dp.is_auto_pick,
        dp.picked_at,
        d.id as draft_id,
        r.settings->>'team_name' as team_name,
        p.full_name as player_name,
        p.position as player_position,
        p.team as player_team
      FROM draft_picks dp
      JOIN drafts d ON d.id = dp.draft_id
      JOIN rosters r ON r.roster_id = dp.roster_id AND r.league_id = d.league_id
      LEFT JOIN players p ON p.id = dp.player_id
      WHERE d.league_id = $1
        AND dp.player_id IS NOT NULL
      ORDER BY dp.picked_at DESC
      LIMIT $2 OFFSET $3
    `;

    const result = await this.db.query(query, [leagueId, limit, offset]);

    return result.rows.map((row) => ({
      id: `draft:${row.pick_id}`,
      type: 'draft' as ActivityType,
      timestamp: new Date(row.picked_at),
      leagueId,
      data: {
        pickId: row.pick_id,
        pickNumber: row.pick_number,
        round: row.round,
        rosterId: row.roster_id,
        teamName: row.team_name || `Team ${row.roster_id}`,
        player: {
          id: row.player_id,
          name: row.player_name,
          position: row.player_position,
          team: row.player_team,
        },
        isAutoPick: row.is_auto_pick,
      },
    }));
  }
}
