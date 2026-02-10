/**
 * Provider-agnostic domain DTOs for stats ingestion
 * These types are stable across all provider implementations and represent
 * the internal data structures used throughout the application.
 */

/** NFL state/season info */
export interface NflState {
  season: number;
  week: number;
  seasonType: 'preseason' | 'regular' | 'postseason';
  displayWeek: number;
}

/** Player stat line for a single week */
export interface PlayerStatLine {
  externalId: string; // Provider-specific ID (populated by mapper)
  // Passing
  passYards?: number;
  passTd?: number;
  passInt?: number;
  passAtt?: number;
  passCmp?: number;
  // Rushing
  rushYards?: number;
  rushTd?: number;
  rushAtt?: number;
  // Receiving
  receptions?: number;
  recYards?: number;
  recTd?: number;
  recTargets?: number;
  // Misc
  fumblesLost?: number;
  pass2pt?: number;
  rush2pt?: number;
  rec2pt?: number;
  // Kicking
  fgMade?: number;
  fgMissed?: number;
  xpMade?: number;
  xpMissed?: number;
  // Defense/ST
  defTd?: number;
  defInt?: number;
  defSacks?: number;
  defFumbleRec?: number;
  defSafety?: number;
  defPointsAllowed?: number;
  defBlkKick?: number;
}

/** Game schedule entry */
export interface GameSchedule {
  gameId: string;
  season: number;
  week: number;
  homeTeam: string;
  awayTeam: string;
  gameTime: Date;
  completed: boolean;
}

/** Injury report entry */
export interface InjuryReport {
  externalId: string;
  status: 'Out' | 'Doubtful' | 'Questionable' | 'Probable' | 'IR' | null;
  injury?: string;
  practiceStatus?: string;
}

/** Player master data (roster info) */
export interface PlayerMasterData {
  externalId: string;
  firstName: string | null;
  lastName: string | null;
  fullName: string;
  position: string | null;
  team: string | null;
  jerseyNumber: number | null;
  yearsExp: number | null;
  age: number | null;
  active: boolean;
  status: string | null;
  injuryStatus: string | null;
}
