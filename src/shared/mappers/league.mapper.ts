/**
 * League Mapper Utilities
 *
 * Provides consistent mapping patterns for league-related database rows.
 */

import { League } from '../../modules/leagues/leagues.model';

/**
 * League mapper class with static methods for database row conversion.
 */
export class LeagueMapper {
  /**
   * Convert a database row to a League object.
   */
  static fromRow(row: any): League {
    return League.fromDatabase(row);
  }

  /**
   * Convert multiple database rows to League objects.
   */
  static fromRows(rows: any[]): League[] {
    return rows.map(League.fromDatabase);
  }
}

/**
 * Public league summary for league browser.
 */
export interface PublicLeagueSummary {
  id: number;
  name: string;
  season: string;
  mode: string;
  totalRosters: number;
  isPublic: boolean;
  memberCount: number;
  hasDues: boolean;
  buyInAmount: number | null;
  currency: string | null;
  paidCount: number;
  fillStatus: 'empty' | 'partial' | 'needs_payment' | 'ready';
}

export class PublicLeagueMapper {
  /**
   * Convert a database row to a PublicLeagueSummary.
   */
  static fromRow(row: any): PublicLeagueSummary {
    const memberCount = Number(row.member_count) || 0;
    const totalRosters = row.total_rosters;
    const hasDues = row.has_dues;
    const paidCount = Number(row.paid_count) || 0;

    return {
      id: row.id,
      name: row.name,
      season: row.season,
      mode: row.mode,
      totalRosters,
      isPublic: row.is_public,
      memberCount,
      hasDues,
      buyInAmount: row.buy_in_amount ? parseFloat(row.buy_in_amount) : null,
      currency: row.currency || null,
      paidCount,
      fillStatus: this.computeFillStatus(memberCount, totalRosters, hasDues, paidCount),
    };
  }

  /**
   * Convert multiple database rows to PublicLeagueSummary objects.
   */
  static fromRows(rows: any[]): PublicLeagueSummary[] {
    return rows.map((row) => this.fromRow(row));
  }

  /**
   * Compute fill status based on member count and payment status.
   */
  private static computeFillStatus(
    memberCount: number,
    totalRosters: number,
    hasDues: boolean,
    paidCount: number
  ): 'empty' | 'partial' | 'needs_payment' | 'ready' {
    if (memberCount === 0) return 'empty';
    if (memberCount < totalRosters) return 'partial';
    if (hasDues && paidCount < memberCount) return 'needs_payment';
    return 'ready';
  }
}

// Re-export League class for convenience
export { League } from '../../modules/leagues/leagues.model';
