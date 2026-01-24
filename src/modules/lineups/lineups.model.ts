/**
 * Lineup models
 */

export type PositionSlot = 'QB' | 'RB' | 'WR' | 'TE' | 'FLEX' | 'K' | 'DEF' | 'BN';

export interface LineupSlots {
  QB: number[];
  RB: number[];
  WR: number[];
  TE: number[];
  FLEX: number[];
  K: number[];
  DEF: number[];
  BN: number[]; // Bench
}

export interface RosterLineup {
  id: number;
  rosterId: number;
  season: number;
  week: number;
  lineup: LineupSlots;
  totalPoints: number | null;
  isLocked: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export function rosterLineupFromDatabase(row: any): RosterLineup {
  const lineup = row.lineup || {};
  return {
    id: row.id,
    rosterId: row.roster_id,
    season: row.season,
    week: row.week,
    lineup: {
      QB: lineup.QB || [],
      RB: lineup.RB || [],
      WR: lineup.WR || [],
      TE: lineup.TE || [],
      FLEX: lineup.FLEX || [],
      K: lineup.K || [],
      DEF: lineup.DEF || [],
      BN: lineup.BN || [],
    },
    totalPoints: row.total_points ? parseFloat(row.total_points) : null,
    isLocked: row.is_locked,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function rosterLineupToResponse(lineup: RosterLineup) {
  return {
    id: lineup.id,
    roster_id: lineup.rosterId,
    season: lineup.season,
    week: lineup.week,
    lineup: lineup.lineup,
    total_points: lineup.totalPoints,
    is_locked: lineup.isLocked,
    created_at: lineup.createdAt,
    updated_at: lineup.updatedAt,
  };
}

// Default roster slot configuration (typical fantasy football)
export interface RosterConfig {
  QB: number;
  RB: number;
  WR: number;
  TE: number;
  FLEX: number;
  K: number;
  DEF: number;
  BN: number;
}

export const DEFAULT_ROSTER_CONFIG: RosterConfig = {
  QB: 1,
  RB: 2,
  WR: 2,
  TE: 1,
  FLEX: 1,
  K: 1,
  DEF: 1,
  BN: 6,
};

export interface LineupValidationResult {
  valid: boolean;
  errors: string[];
}
