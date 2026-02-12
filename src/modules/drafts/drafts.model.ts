/** Valid draft types */
export type DraftType = 'snake' | 'linear' | 'auction';

/** Draft status values */
export type DraftStatus = 'not_started' | 'in_progress' | 'paused' | 'completed';

/** Roster population status after draft completion */
export type RosterPopulationStatus = 'pending' | 'complete' | 'failed';

/** Draft phase values for workflow stage */
export type DraftPhase = 'SETUP' | 'DERBY' | 'LIVE';

/** Auction-specific settings stored in draft.settings */
export interface AuctionSettings {
  auctionMode: 'slow' | 'fast';
  bidWindowSeconds: number;
  maxActiveNominationsPerTeam: number;
  maxActiveNominationsGlobal?: number;
  dailyNominationLimit?: number;
  nominationSeconds: number;
  resetOnBidSeconds: number;
  minBid: number;
  minIncrement: number;
  maxLotDurationSeconds?: number;
}

/** Player pool options for draft eligibility */
export type PlayerPoolType = 'veteran' | 'rookie' | 'college';

/** Draft settings that extend auction settings with player pool filtering */
export interface DraftSettings extends Partial<AuctionSettings> {
  playerPool?: PlayerPoolType[];  // default: ['veteran', 'rookie']
  /** For vet-only drafts: include rookie draft picks as draftable items */
  includeRookiePicks?: boolean;
  /** The season for which rookie draft picks should be included */
  rookiePicksSeason?: number;
  /** Number of rounds for generated rookie picks (1-5, default 5) */
  rookiePicksRounds?: number;
}

/** Default auction settings */
export const DEFAULT_AUCTION_SETTINGS: AuctionSettings = {
  auctionMode: 'slow',
  bidWindowSeconds: 43200, // 12 hours
  maxActiveNominationsPerTeam: 2,
  maxActiveNominationsGlobal: 25,
  dailyNominationLimit: undefined, // unlimited by default
  nominationSeconds: 45,
  resetOnBidSeconds: 10,
  minBid: 1,
  minIncrement: 1,
};

export interface Draft {
  id: number;
  leagueId: number;
  draftType: DraftType;
  status: DraftStatus;
  phase: DraftPhase;
  currentPick: number;
  currentRound: number;
  currentRosterId: number | null;
  pickTimeSeconds: number;
  pickDeadline: Date | null;
  rounds: number;
  scheduledStart: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  settings: DraftSettings;
  draftState: Record<string, any>;
  orderConfirmed: boolean;
  rosterPopulationStatus: RosterPopulationStatus | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface DraftOrderEntry {
  id: number;
  draftId: number;
  rosterId: number;
  draftPosition: number;
  username?: string;
  isAutodraftEnabled: boolean;
}

export interface DraftPick {
  id: number;
  draftId: number;
  pickNumber: number;
  round: number;
  pickInRound: number;
  rosterId: number;
  playerId: number | null;
  isAutoPick: boolean;
  pickedAt: Date;
  playerName?: string;
  playerPosition?: string;
  playerTeam?: string;
  username?: string;
}

export function draftFromDatabase(row: any): Draft {
  return {
    id: row.id,
    leagueId: row.league_id,
    draftType: row.draft_type,
    status: row.status,
    phase: row.phase ?? 'SETUP',
    currentPick: row.current_pick,
    currentRound: row.current_round,
    currentRosterId: row.current_roster_id,
    pickTimeSeconds: row.pick_time_seconds,
    pickDeadline: row.pick_deadline,
    rounds: row.rounds,
    scheduledStart: row.scheduled_start,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    settings: row.settings || {},
    draftState: row.draft_state || {},
    orderConfirmed: row.order_confirmed ?? false,
    rosterPopulationStatus: row.roster_population_status ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Compute a human-readable label for a draft based on its player pool configuration.
 */
export function computeDraftLabel(playerPool?: PlayerPoolType[]): string {
  if (!playerPool || playerPool.length === 0) return 'Draft';

  const sorted = [...playerPool].sort();
  const key = sorted.join('+');

  const labelMap: Record<string, string> = {
    'veteran': 'Veteran Draft',
    'rookie': 'Rookie Draft',
    'college': 'College Draft',
    'rookie+veteran': 'Startup Draft',
    'college+rookie+veteran': 'Combined Draft',
    'college+rookie': 'Future Draft',
    'college+veteran': 'Veteran + College Draft',
  };

  return labelMap[key] || 'Draft';
}

/** Response shape returned by draftToResponse (snake_case for API) */
export interface DraftResponse {
  id: number;
  league_id: number;
  draft_type: DraftType;
  status: DraftStatus;
  phase: DraftPhase;
  current_pick: number;
  current_round: number;
  current_roster_id: number | null;
  pick_time_seconds: number;
  pick_deadline: Date | null;
  rounds: number;
  scheduled_start: Date | null;
  started_at: Date | null;
  completed_at: Date | null;
  settings: DraftSettings;
  draft_state: Record<string, any>;
  order_confirmed: boolean;
  created_at: Date;
  updated_at: Date;
  label: string;
}

/** DraftResponse extended with optional warnings (e.g. schedule generation failure) */
export interface DraftResponseWithWarnings extends DraftResponse {
  warnings?: Array<{
    code: string;
    message: string;
    error?: string;
  }>;
}

export function draftToResponse(draft: Draft): DraftResponse {
  const playerPool = draft.settings?.playerPool;

  return {
    id: draft.id,
    league_id: draft.leagueId,
    draft_type: draft.draftType,
    status: draft.status,
    phase: draft.phase,
    current_pick: draft.currentPick,
    current_round: draft.currentRound,
    current_roster_id: draft.currentRosterId,
    pick_time_seconds: draft.pickTimeSeconds,
    pick_deadline: draft.pickDeadline,
    rounds: draft.rounds,
    scheduled_start: draft.scheduledStart,
    started_at: draft.startedAt,
    completed_at: draft.completedAt,
    settings: draft.settings,
    draft_state: draft.draftState,
    order_confirmed: draft.orderConfirmed,
    created_at: draft.createdAt,
    updated_at: draft.updatedAt,
    label: computeDraftLabel(playerPool),
  };
}
