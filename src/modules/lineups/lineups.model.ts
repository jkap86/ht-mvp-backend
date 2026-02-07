/**
 * Lineup models
 */

export type PositionSlot =
  | 'QB' | 'RB' | 'WR' | 'TE'
  | 'FLEX' | 'SUPER_FLEX' | 'REC_FLEX'
  | 'K' | 'DEF'
  | 'DL' | 'LB' | 'DB' | 'IDP_FLEX'
  | 'BN' | 'IR' | 'TAXI';

export interface LineupSlots {
  QB: number[];
  RB: number[];
  WR: number[];
  TE: number[];
  FLEX: number[];
  SUPER_FLEX: number[];
  REC_FLEX: number[];
  K: number[];
  DEF: number[];
  DL: number[];
  LB: number[];
  DB: number[];
  IDP_FLEX: number[];
  BN: number[]; // Bench
  IR: number[]; // Injured Reserve
  TAXI: number[]; // Taxi Squad (dynasty only)
}

export interface RosterLineup {
  id: number;
  rosterId: number;
  season: number;
  week: number;
  lineup: LineupSlots;
  totalPoints: number | null;
  totalPointsLive: number | null;
  totalPointsProjectedLive: number | null;
  isLocked: boolean;
  isBestball: boolean;
  bestballGeneratedAt: Date | null;
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
      SUPER_FLEX: lineup.SUPER_FLEX || [],
      REC_FLEX: lineup.REC_FLEX || [],
      K: lineup.K || [],
      DEF: lineup.DEF || [],
      DL: lineup.DL || [],
      LB: lineup.LB || [],
      DB: lineup.DB || [],
      IDP_FLEX: lineup.IDP_FLEX || [],
      BN: lineup.BN || [],
      IR: lineup.IR || [],
      TAXI: lineup.TAXI || [],
    },
    totalPoints: row.total_points ? parseFloat(row.total_points) : null,
    totalPointsLive: row.total_points_live ? parseFloat(row.total_points_live) : null,
    totalPointsProjectedLive: row.total_points_projected_live
      ? parseFloat(row.total_points_projected_live)
      : null,
    isLocked: row.is_locked,
    isBestball: row.is_bestball || false,
    bestballGeneratedAt: row.bestball_generated_at || null,
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
    total_points_live: lineup.totalPointsLive,
    total_points_projected_live: lineup.totalPointsProjectedLive,
    is_locked: lineup.isLocked,
    is_bestball: lineup.isBestball,
    bestball_generated_at: lineup.bestballGeneratedAt,
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
  SUPER_FLEX: number;
  REC_FLEX: number;
  K: number;
  DEF: number;
  DL: number;
  LB: number;
  DB: number;
  IDP_FLEX: number;
  BN: number;
  IR: number;
  TAXI: number;
}

export const DEFAULT_ROSTER_CONFIG: RosterConfig = {
  QB: 1,
  RB: 2,
  WR: 2,
  TE: 1,
  FLEX: 1,
  SUPER_FLEX: 0,
  REC_FLEX: 0,
  K: 1,
  DEF: 1,
  DL: 0,
  LB: 0,
  DB: 0,
  IDP_FLEX: 0,
  BN: 6,
  IR: 0,
  TAXI: 0,
};

export interface LineupValidationResult {
  valid: boolean;
  errors: string[];
}
