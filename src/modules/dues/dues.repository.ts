import { Pool } from 'pg';
import {
  LeagueDues,
  DuesPayment,
  DuesPaymentWithRoster,
  leagueDuesFromDatabase,
  duesPaymentFromDatabase,
  duesPaymentWithRosterFromDatabase,
  PayoutStructure,
} from './dues.model';
import { runInTransaction } from '../../shared/transaction-runner';

export interface UpsertDuesConfigParams {
  leagueId: number;
  buyInAmount: number;
  payoutStructure?: PayoutStructure;
  currency?: string;
  notes?: string | null;
}

export interface MarkPaymentParams {
  leagueId: number;
  rosterId: number;
  isPaid: boolean;
  markedByUserId: string;
  notes?: string | null;
}

export class DuesRepository {
  constructor(private readonly db: Pool) {}

  /**
   * Get dues configuration for a league
   */
  async getDuesConfig(leagueId: number): Promise<LeagueDues | null> {
    const result = await this.db.query(
      'SELECT * FROM league_dues WHERE league_id = $1',
      [leagueId]
    );

    if (result.rows.length === 0) return null;
    return leagueDuesFromDatabase(result.rows[0]);
  }

  /**
   * Create or update dues configuration for a league
   */
  async upsertDuesConfig(params: UpsertDuesConfigParams): Promise<LeagueDues> {
    const result = await this.db.query(
      `INSERT INTO league_dues (league_id, buy_in_amount, payout_structure, currency, notes)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (league_id) DO UPDATE SET
         buy_in_amount = EXCLUDED.buy_in_amount,
         payout_structure = EXCLUDED.payout_structure,
         currency = EXCLUDED.currency,
         notes = EXCLUDED.notes,
         updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [
        params.leagueId,
        params.buyInAmount,
        JSON.stringify(params.payoutStructure || {}),
        params.currency || 'USD',
        params.notes || null,
      ]
    );

    return leagueDuesFromDatabase(result.rows[0]);
  }

  /**
   * Delete dues configuration for a league
   */
  async deleteDuesConfig(leagueId: number): Promise<boolean> {
    return runInTransaction(this.db, async (client) => {
      const result = await client.query(
        'DELETE FROM league_dues WHERE league_id = $1',
        [leagueId]
      );
      // Also delete all payment records for this league
      await client.query('DELETE FROM dues_payments WHERE league_id = $1', [leagueId]);
      return result.rowCount !== null && result.rowCount > 0;
    });
  }

  /**
   * Get all payment statuses for a league with roster details
   */
  async getPaymentStatuses(leagueId: number): Promise<DuesPaymentWithRoster[]> {
    const result = await this.db.query(
      `SELECT
        dp.*,
        r.roster_id as roster_id,
        COALESCE(r.settings->>'team_name', u.username, 'Team ' || r.roster_id) as team_name,
        u.username
       FROM rosters r
       INNER JOIN users u ON r.user_id = u.id
       LEFT JOIN dues_payments dp ON dp.roster_id = r.id AND dp.league_id = r.league_id
       WHERE r.league_id = $1 AND r.is_benched = false
       ORDER BY team_name`,
      [leagueId]
    );

    return result.rows.map((row) => ({
      id: row.id || 0,
      leagueId: leagueId,
      rosterId: row.roster_id,
      isPaid: row.is_paid || false,
      paidAt: row.paid_at,
      markedByUserId: row.marked_by_user_id,
      notes: row.notes,
      createdAt: row.created_at || null,
      updatedAt: row.updated_at || null,
      teamName: row.team_name,
      username: row.username,
    }));
  }

  /**
   * Get payment status for a specific roster
   */
  async getPaymentStatus(leagueId: number, rosterId: number): Promise<DuesPayment | null> {
    const result = await this.db.query(
      'SELECT * FROM dues_payments WHERE league_id = $1 AND roster_id = $2',
      [leagueId, rosterId]
    );

    if (result.rows.length === 0) return null;
    return duesPaymentFromDatabase(result.rows[0]);
  }

  /**
   * Mark payment status for a roster
   * Note: notes=undefined preserves existing notes, notes=null or notes=string sets the value
   */
  async markPaymentStatus(params: MarkPaymentParams): Promise<DuesPayment> {
    const notesProvided = params.notes !== undefined;
    const notesClause = notesProvided ? 'EXCLUDED.notes' : 'dues_payments.notes';

    const result = await this.db.query(
      `INSERT INTO dues_payments (league_id, roster_id, is_paid, paid_at, marked_by_user_id, notes)
       VALUES ($1, $2, $3, ${params.isPaid ? 'CURRENT_TIMESTAMP' : 'NULL'}, $4, $5)
       ON CONFLICT (league_id, roster_id) DO UPDATE SET
         is_paid = EXCLUDED.is_paid,
         paid_at = ${params.isPaid ? 'CURRENT_TIMESTAMP' : 'NULL'},
         marked_by_user_id = EXCLUDED.marked_by_user_id,
         notes = ${notesClause},
         updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [
        params.leagueId,
        params.rosterId,
        params.isPaid,
        params.markedByUserId,
        notesProvided ? params.notes : null,
      ]
    );

    return duesPaymentFromDatabase(result.rows[0]);
  }

  /**
   * Get payment summary for a league (total paid, total expected)
   */
  async getPaymentSummary(leagueId: number): Promise<{ paidCount: number; totalCount: number }> {
    const result = await this.db.query(
      `SELECT
        COUNT(*) FILTER (WHERE dp.is_paid = true) as paid_count,
        COUNT(*) as total_count
       FROM rosters r
       LEFT JOIN dues_payments dp ON dp.roster_id = r.id AND dp.league_id = r.league_id
       WHERE r.league_id = $1 AND r.is_benched = false`,
      [leagueId]
    );

    return {
      paidCount: Number(result.rows[0].paid_count) || 0,
      totalCount: Number(result.rows[0].total_count) || 0,
    };
  }
}
