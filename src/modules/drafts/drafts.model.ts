/** Valid draft types */
export type DraftType = 'snake' | 'linear' | 'auction';

/** Draft status values */
export type DraftStatus = 'not_started' | 'in_progress' | 'paused' | 'completed';

/** Auction-specific settings stored in draft.settings */
export interface AuctionSettings {
  auctionMode: 'slow' | 'fast';
  bidWindowSeconds: number;
  maxActiveNominationsPerTeam: number;
  nominationSeconds: number;
  resetOnBidSeconds: number;
  minBid: number;
  minIncrement: number;
}

/** Default auction settings */
export const DEFAULT_AUCTION_SETTINGS: AuctionSettings = {
  auctionMode: 'slow',
  bidWindowSeconds: 43200,        // 12 hours
  maxActiveNominationsPerTeam: 2,
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
  currentPick: number;
  currentRound: number;
  currentRosterId: number | null;
  pickTimeSeconds: number;
  pickDeadline: Date | null;
  rounds: number;
  startedAt: Date | null;
  completedAt: Date | null;
  settings: AuctionSettings | Record<string, any>;
  draftState: Record<string, any>;
  orderConfirmed: boolean;
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
    currentPick: row.current_pick,
    currentRound: row.current_round,
    currentRosterId: row.current_roster_id,
    pickTimeSeconds: row.pick_time_seconds,
    pickDeadline: row.pick_deadline,
    rounds: row.rounds,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    settings: row.settings || {},
    draftState: row.draft_state || {},
    orderConfirmed: row.order_confirmed ?? false,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function draftToResponse(draft: Draft) {
  return {
    id: draft.id,
    league_id: draft.leagueId,
    draft_type: draft.draftType,
    status: draft.status,
    current_pick: draft.currentPick,
    current_round: draft.currentRound,
    current_roster_id: draft.currentRosterId,
    pick_time_seconds: draft.pickTimeSeconds,
    pick_deadline: draft.pickDeadline,
    rounds: draft.rounds,
    started_at: draft.startedAt,
    completed_at: draft.completedAt,
    settings: draft.settings,
    draft_state: draft.draftState,
    order_confirmed: draft.orderConfirmed,
    created_at: draft.createdAt,
    updated_at: draft.updatedAt,
  };
}
