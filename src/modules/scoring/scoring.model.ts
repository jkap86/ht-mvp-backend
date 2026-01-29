/**
 * Scoring and player stats models
 */

export interface PlayerStats {
  id: number;
  playerId: number;
  season: number;
  week: number;
  // Passing
  passYards: number;
  passTd: number;
  passInt: number;
  // Rushing
  rushYards: number;
  rushTd: number;
  // Receiving
  receptions: number;
  recYards: number;
  recTd: number;
  // Misc
  fumblesLost: number;
  twoPtConversions: number;
  // Kicking
  fgMade: number;
  fgMissed: number;
  patMade: number;
  patMissed: number;
  // Defense
  defTd: number;
  defInt: number;
  defSacks: number;
  defFumbleRec: number;
  defSafety: number;
  defPointsAllowed: number;
  // Timestamps
  createdAt: Date;
  updatedAt: Date;
}

export function playerStatsFromDatabase(row: any): PlayerStats {
  return {
    id: row.id,
    playerId: row.player_id,
    season: row.season,
    week: row.week,
    passYards: row.pass_yards || 0,
    passTd: row.pass_td || 0,
    passInt: row.pass_int || 0,
    rushYards: row.rush_yards || 0,
    rushTd: row.rush_td || 0,
    receptions: row.receptions || 0,
    recYards: row.rec_yards || 0,
    recTd: row.rec_td || 0,
    fumblesLost: row.fumbles_lost || 0,
    twoPtConversions: row.two_pt_conversions || 0,
    fgMade: row.fg_made || 0,
    fgMissed: row.fg_missed || 0,
    patMade: row.pat_made || 0,
    patMissed: row.pat_missed || 0,
    defTd: row.def_td || 0,
    defInt: row.def_int || 0,
    defSacks: parseFloat(row.def_sacks) || 0,
    defFumbleRec: row.def_fumble_rec || 0,
    defSafety: row.def_safety || 0,
    defPointsAllowed: row.def_points_allowed || 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function playerStatsToResponse(stats: PlayerStats) {
  return {
    id: stats.id,
    player_id: stats.playerId,
    season: stats.season,
    week: stats.week,
    pass_yards: stats.passYards,
    pass_td: stats.passTd,
    pass_int: stats.passInt,
    rush_yards: stats.rushYards,
    rush_td: stats.rushTd,
    receptions: stats.receptions,
    rec_yards: stats.recYards,
    rec_td: stats.recTd,
    fumbles_lost: stats.fumblesLost,
    two_pt_conversions: stats.twoPtConversions,
    fg_made: stats.fgMade,
    fg_missed: stats.fgMissed,
    pat_made: stats.patMade,
    pat_missed: stats.patMissed,
    def_td: stats.defTd,
    def_int: stats.defInt,
    def_sacks: stats.defSacks,
    def_fumble_rec: stats.defFumbleRec,
    def_safety: stats.defSafety,
    def_points_allowed: stats.defPointsAllowed,
  };
}

export type ScoringType = 'ppr' | 'half_ppr' | 'standard';

export interface ScoringRules {
  // Passing
  passYards: number; // points per yard (e.g., 0.04)
  passTd: number; // points per TD (e.g., 4)
  passInt: number; // points per INT (e.g., -2)
  // Rushing
  rushYards: number; // e.g., 0.1
  rushTd: number; // e.g., 6
  // Receiving
  receptions: number; // PPR: 1, Half: 0.5, Standard: 0
  recYards: number; // e.g., 0.1
  recTd: number; // e.g., 6
  // Misc
  fumblesLost: number; // e.g., -2
  twoPtConversions: number; // e.g., 2
  // Kicking
  fgMade: number; // e.g., 3
  fgMissed: number; // e.g., -1
  patMade: number; // e.g., 1
  patMissed: number; // e.g., -1
  // Defense
  defTd: number; // e.g., 6
  defInt: number; // e.g., 2
  defSack: number; // e.g., 1
  defFumbleRec: number; // e.g., 2
  defSafety: number; // e.g., 2
  // Defensive points allowed brackets
  defPointsAllowed0: number; // 0 points: e.g., 10
  defPointsAllowed1to6: number; // 1-6 points: e.g., 7
  defPointsAllowed7to13: number;
  defPointsAllowed14to20: number;
  defPointsAllowed21to27: number;
  defPointsAllowed28to34: number;
  defPointsAllowed35plus: number;
}

export const DEFAULT_SCORING_RULES: Record<ScoringType, ScoringRules> = {
  ppr: {
    passYards: 0.04,
    passTd: 4,
    passInt: -2,
    rushYards: 0.1,
    rushTd: 6,
    receptions: 1,
    recYards: 0.1,
    recTd: 6,
    fumblesLost: -2,
    twoPtConversions: 2,
    fgMade: 3,
    fgMissed: -1,
    patMade: 1,
    patMissed: -1,
    defTd: 6,
    defInt: 2,
    defSack: 1,
    defFumbleRec: 2,
    defSafety: 2,
    defPointsAllowed0: 10,
    defPointsAllowed1to6: 7,
    defPointsAllowed7to13: 4,
    defPointsAllowed14to20: 1,
    defPointsAllowed21to27: 0,
    defPointsAllowed28to34: -1,
    defPointsAllowed35plus: -4,
  },
  half_ppr: {
    passYards: 0.04,
    passTd: 4,
    passInt: -2,
    rushYards: 0.1,
    rushTd: 6,
    receptions: 0.5,
    recYards: 0.1,
    recTd: 6,
    fumblesLost: -2,
    twoPtConversions: 2,
    fgMade: 3,
    fgMissed: -1,
    patMade: 1,
    patMissed: -1,
    defTd: 6,
    defInt: 2,
    defSack: 1,
    defFumbleRec: 2,
    defSafety: 2,
    defPointsAllowed0: 10,
    defPointsAllowed1to6: 7,
    defPointsAllowed7to13: 4,
    defPointsAllowed14to20: 1,
    defPointsAllowed21to27: 0,
    defPointsAllowed28to34: -1,
    defPointsAllowed35plus: -4,
  },
  standard: {
    passYards: 0.04,
    passTd: 4,
    passInt: -2,
    rushYards: 0.1,
    rushTd: 6,
    receptions: 0,
    recYards: 0.1,
    recTd: 6,
    fumblesLost: -2,
    twoPtConversions: 2,
    fgMade: 3,
    fgMissed: -1,
    patMade: 1,
    patMissed: -1,
    defTd: 6,
    defInt: 2,
    defSack: 1,
    defFumbleRec: 2,
    defSafety: 2,
    defPointsAllowed0: 10,
    defPointsAllowed1to6: 7,
    defPointsAllowed7to13: 4,
    defPointsAllowed14to20: 1,
    defPointsAllowed21to27: 0,
    defPointsAllowed28to34: -1,
    defPointsAllowed35plus: -4,
  },
};
