/**
 * Waivers system domain models
 */

export type WaiverType = 'standard' | 'faab' | 'none';
export type WaiverClaimStatus = 'pending' | 'successful' | 'failed' | 'cancelled' | 'invalid';

/**
 * Waiver priority for a roster in a league/season
 */
export interface WaiverPriority {
  id: number;
  leagueId: number;
  rosterId: number;
  season: number;
  priority: number;
  updatedAt: Date;
}

export interface WaiverPriorityWithDetails extends WaiverPriority {
  teamName: string;
  username: string;
}

/**
 * FAAB budget tracking
 */
export interface FaabBudget {
  id: number;
  leagueId: number;
  rosterId: number;
  season: number;
  initialBudget: number;
  remainingBudget: number;
  updatedAt: Date;
}

export interface FaabBudgetWithDetails extends FaabBudget {
  teamName: string;
  username: string;
}

/**
 * Waiver claim
 */
export interface WaiverClaim {
  id: number;
  leagueId: number;
  rosterId: number;
  playerId: number;
  dropPlayerId: number | null;
  bidAmount: number;
  priorityAtClaim: number | null;
  status: WaiverClaimStatus;
  season: number;
  week: number;
  processedAt: Date | null;
  failureReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface WaiverClaimWithDetails extends WaiverClaim {
  teamName: string;
  username: string;
  playerName: string;
  playerPosition: string | null;
  playerTeam: string | null;
  dropPlayerName: string | null;
  dropPlayerPosition: string | null;
}

/**
 * Player on waiver wire (recently dropped)
 */
export interface WaiverWirePlayer {
  id: number;
  leagueId: number;
  playerId: number;
  droppedByRosterId: number | null;
  waiverExpiresAt: Date;
  season: number;
  week: number;
  createdAt: Date;
}

export interface WaiverWirePlayerWithDetails extends WaiverWirePlayer {
  playerName: string;
  playerPosition: string | null;
  playerTeam: string | null;
  droppedByTeamName: string | null;
}

/**
 * Request DTOs
 */
export interface SubmitClaimRequest {
  playerId: number;
  dropPlayerId?: number;
  bidAmount?: number;
}

export interface UpdateClaimRequest {
  bidAmount?: number;
  dropPlayerId?: number | null;
}

/**
 * Waiver settings from league.settings JSONB
 */
export interface WaiverSettings {
  waiverType: WaiverType;
  waiverDay: number; // 0-6 (Sunday-Saturday)
  waiverHour: number; // 0-23 UTC
  waiverPeriodDays: number;
  faabBudget: number;
}

/**
 * Convert database row to WaiverPriority
 */
export function waiverPriorityFromDatabase(row: any): WaiverPriority {
  return {
    id: row.id,
    leagueId: row.league_id,
    rosterId: row.roster_id,
    season: row.season,
    priority: row.priority,
    updatedAt: row.updated_at,
  };
}

/**
 * Convert database row to FaabBudget
 */
export function faabBudgetFromDatabase(row: any): FaabBudget {
  return {
    id: row.id,
    leagueId: row.league_id,
    rosterId: row.roster_id,
    season: row.season,
    initialBudget: row.initial_budget,
    remainingBudget: row.remaining_budget,
    updatedAt: row.updated_at,
  };
}

/**
 * Convert database row to WaiverClaim
 */
export function waiverClaimFromDatabase(row: any): WaiverClaim {
  return {
    id: row.id,
    leagueId: row.league_id,
    rosterId: row.roster_id,
    playerId: row.player_id,
    dropPlayerId: row.drop_player_id,
    bidAmount: row.bid_amount,
    priorityAtClaim: row.priority_at_claim,
    status: row.status,
    season: row.season,
    week: row.week,
    processedAt: row.processed_at,
    failureReason: row.failure_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Convert database row to WaiverWirePlayer
 */
export function waiverWirePlayerFromDatabase(row: any): WaiverWirePlayer {
  return {
    id: row.id,
    leagueId: row.league_id,
    playerId: row.player_id,
    droppedByRosterId: row.dropped_by_roster_id,
    waiverExpiresAt: row.waiver_expires_at,
    season: row.season,
    week: row.week,
    createdAt: row.created_at,
  };
}

/**
 * Convert WaiverPriority to API response (snake_case)
 */
export function waiverPriorityToResponse(wp: WaiverPriorityWithDetails): Record<string, any> {
  return {
    id: wp.id,
    league_id: wp.leagueId,
    roster_id: wp.rosterId,
    season: wp.season,
    priority: wp.priority,
    team_name: wp.teamName,
    username: wp.username,
    updated_at: wp.updatedAt,
  };
}

/**
 * Convert FaabBudget to API response (snake_case)
 */
export function faabBudgetToResponse(fb: FaabBudgetWithDetails): Record<string, any> {
  return {
    id: fb.id,
    league_id: fb.leagueId,
    roster_id: fb.rosterId,
    season: fb.season,
    initial_budget: fb.initialBudget,
    remaining_budget: fb.remainingBudget,
    team_name: fb.teamName,
    username: fb.username,
    updated_at: fb.updatedAt,
  };
}

/**
 * Convert WaiverClaim to API response (snake_case)
 */
export function waiverClaimToResponse(wc: WaiverClaimWithDetails): Record<string, any> {
  return {
    id: wc.id,
    league_id: wc.leagueId,
    roster_id: wc.rosterId,
    player_id: wc.playerId,
    player_name: wc.playerName,
    player_position: wc.playerPosition,
    player_team: wc.playerTeam,
    drop_player_id: wc.dropPlayerId,
    drop_player_name: wc.dropPlayerName,
    drop_player_position: wc.dropPlayerPosition,
    bid_amount: wc.bidAmount,
    priority_at_claim: wc.priorityAtClaim,
    status: wc.status,
    season: wc.season,
    week: wc.week,
    team_name: wc.teamName,
    username: wc.username,
    processed_at: wc.processedAt,
    failure_reason: wc.failureReason,
    created_at: wc.createdAt,
    updated_at: wc.updatedAt,
  };
}

/**
 * Convert WaiverWirePlayer to API response (snake_case)
 */
export function waiverWirePlayerToResponse(wwp: WaiverWirePlayerWithDetails): Record<string, any> {
  return {
    id: wwp.id,
    league_id: wwp.leagueId,
    player_id: wwp.playerId,
    player_name: wwp.playerName,
    player_position: wwp.playerPosition,
    player_team: wwp.playerTeam,
    dropped_by_roster_id: wwp.droppedByRosterId,
    dropped_by_team_name: wwp.droppedByTeamName,
    waiver_expires_at: wwp.waiverExpiresAt,
    season: wwp.season,
    week: wwp.week,
    created_at: wwp.createdAt,
  };
}

/**
 * Parse waiver settings from league.settings JSONB
 */
export function parseWaiverSettings(settings: Record<string, any> | null): WaiverSettings {
  return {
    waiverType: (settings?.waiver_type as WaiverType) || 'none',
    waiverDay: settings?.waiver_day ?? 2, // Tuesday
    waiverHour: settings?.waiver_hour ?? 3, // 3 AM UTC
    waiverPeriodDays: settings?.waiver_period_days ?? 2,
    faabBudget: settings?.faab_budget ?? 100,
  };
}

/**
 * Resolve current week from league object
 * Checks settings.current_week first (legacy/flexible storage), then currentWeek property, then current_week property
 */
export function resolveLeagueCurrentWeek(league: any): number | null {
  return league?.settings?.current_week ?? league?.currentWeek ?? league?.current_week ?? null;
}
