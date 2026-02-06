/**
 * Roster Mapper Utilities
 *
 * Provides consistent mapping patterns for roster-related database rows.
 */

import type { Roster } from '../../modules/leagues/leagues.model';
import type {
  RosterPlayer,
  RosterPlayerWithDetails,
  RosterTransaction,
} from '../../modules/rosters/rosters.model';
import {
  rosterPlayerFromDatabase,
  rosterTransactionFromDatabase,
} from '../../modules/rosters/rosters.model';

/**
 * Roster mapper class with static methods for database row conversion.
 */
export class RosterMapper {
  /**
   * Convert a database row to a Roster object.
   */
  static fromRow(row: any): Roster {
    return {
      id: row.id,
      leagueId: row.league_id,
      userId: row.user_id,
      rosterId: row.roster_id,
      settings: row.settings || {},
      starters: row.starters || [],
      bench: row.bench || [],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      username: row.username,
      isBenched: row.is_benched || false,
    };
  }

  /**
   * Convert multiple database rows to Roster objects.
   */
  static fromRows(rows: any[]): Roster[] {
    return rows.map(this.fromRow);
  }
}

/**
 * RosterPlayer mapper.
 */
export class RosterPlayerMapper {
  /**
   * Convert a database row to a RosterPlayer object.
   */
  static fromRow(row: any): RosterPlayer {
    return rosterPlayerFromDatabase(row);
  }

  /**
   * Convert multiple database rows to RosterPlayer objects.
   */
  static fromRows(rows: any[]): RosterPlayer[] {
    return rows.map(rosterPlayerFromDatabase);
  }

  /**
   * Convert a database row with player details to RosterPlayerWithDetails.
   */
  static fromRowWithDetails(row: any): RosterPlayerWithDetails {
    return {
      ...rosterPlayerFromDatabase(row),
      fullName: row.full_name,
      position: row.position,
      team: row.team,
      status: row.status,
      injuryStatus: row.injury_status,
    };
  }

  /**
   * Convert multiple database rows with player details.
   */
  static fromRowsWithDetails(rows: any[]): RosterPlayerWithDetails[] {
    return rows.map(this.fromRowWithDetails);
  }
}

/**
 * RosterTransaction mapper.
 */
export class RosterTransactionMapper {
  /**
   * Convert a database row to a RosterTransaction object.
   */
  static fromRow(row: any): RosterTransaction {
    return rosterTransactionFromDatabase(row);
  }

  /**
   * Convert multiple database rows to RosterTransaction objects.
   */
  static fromRows(rows: any[]): RosterTransaction[] {
    return rows.map(rosterTransactionFromDatabase);
  }
}

// Re-export original model functions for backward compatibility
export { rosterPlayerFromDatabase, rosterTransactionFromDatabase } from '../../modules/rosters/rosters.model';
