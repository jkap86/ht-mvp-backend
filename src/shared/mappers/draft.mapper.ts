/**
 * Draft Mapper Utilities
 *
 * Re-exports and extends the draft model's fromDatabase functions.
 * Provides consistent mapping patterns with fromRow/fromRows methods.
 */

import type { Draft, DraftOrderEntry, DraftPick } from '../../modules/drafts/drafts.model';
import { draftFromDatabase } from '../../modules/drafts/drafts.model';

/**
 * Draft mapper class with static methods for database row conversion.
 */
export class DraftMapper {
  /**
   * Convert a database row to a Draft object.
   */
  static fromRow(row: any): Draft {
    return draftFromDatabase(row);
  }

  /**
   * Convert multiple database rows to Draft objects.
   */
  static fromRows(rows: any[]): Draft[] {
    return rows.map(draftFromDatabase);
  }
}

/**
 * DraftOrderEntry mapper.
 */
export class DraftOrderMapper {
  /**
   * Convert a database row to a DraftOrderEntry object.
   */
  static fromRow(row: any): DraftOrderEntry {
    return {
      id: row.id,
      draftId: row.draft_id,
      rosterId: row.roster_id,
      draftPosition: row.draft_position,
      username: row.username,
      isAutodraftEnabled: row.is_autodraft_enabled ?? false,
    };
  }

  /**
   * Convert multiple database rows to DraftOrderEntry objects.
   */
  static fromRows(rows: any[]): DraftOrderEntry[] {
    return rows.map(this.fromRow);
  }
}

/**
 * DraftPick mapper.
 */
export class DraftPickMapper {
  /**
   * Convert a database row to a DraftPick object.
   */
  static fromRow(row: any): DraftPick {
    return {
      id: row.id,
      draftId: row.draft_id,
      pickNumber: row.pick_number,
      round: row.round,
      pickInRound: row.pick_in_round,
      rosterId: row.roster_id,
      playerId: row.player_id,
      isAutoPick: row.is_auto_pick,
      pickedAt: row.picked_at,
      playerName: row.player_name,
      playerPosition: row.player_position,
      playerTeam: row.player_team,
      username: row.username,
    };
  }

  /**
   * Convert multiple database rows to DraftPick objects.
   */
  static fromRows(rows: any[]): DraftPick[] {
    return rows.map(this.fromRow);
  }
}

/**
 * Queue entry mapping for draft queues.
 */
export interface QueueEntry {
  id: number;
  draftId: number;
  rosterId: number;
  playerId: number | null;
  queuePosition: number;
  playerName?: string;
  playerPosition?: string;
  playerTeam?: string;
  pickAssetId?: number;
  pickAssetSeason?: number;
  pickAssetRound?: number;
  pickAssetDisplayName?: string;
  originalTeamName?: string;
}

export class QueueEntryMapper {
  /**
   * Convert a database row to a QueueEntry object.
   */
  static fromRow(row: any): QueueEntry {
    let pickAssetDisplayName: string | undefined;
    if (row.pick_asset_id) {
      pickAssetDisplayName = `${row.pick_asset_season} Round ${row.pick_asset_round} - ${row.original_team_name}`;
    }

    return {
      id: row.id,
      draftId: row.draft_id,
      rosterId: row.roster_id,
      playerId: row.player_id,
      queuePosition: row.queue_position,
      playerName: row.player_name,
      playerPosition: row.player_position,
      playerTeam: row.player_team,
      pickAssetId: row.pick_asset_id,
      pickAssetSeason: row.pick_asset_season,
      pickAssetRound: row.pick_asset_round,
      pickAssetDisplayName,
      originalTeamName: row.original_team_name,
    };
  }

  /**
   * Convert multiple database rows to QueueEntry objects.
   */
  static fromRows(rows: any[]): QueueEntry[] {
    return rows.map(this.fromRow);
  }
}

// Re-export the original model functions for backward compatibility
export { draftFromDatabase } from '../../modules/drafts/drafts.model';
