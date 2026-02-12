/**
 * Trade system domain models
 */

export type TradeItemType = 'player' | 'draft_pick';

export type TradeStatus =
  | 'pending'
  | 'countered'
  | 'accepted'
  | 'in_review'
  | 'completed'
  | 'rejected'
  | 'cancelled'
  | 'expired'
  | 'vetoed'
  | 'failed';

export type LeagueChatMode = 'none' | 'summary' | 'details';

export interface Trade {
  id: number;
  leagueId: number;
  proposerRosterId: number;
  recipientRosterId: number;
  status: TradeStatus;
  parentTradeId: number | null;
  expiresAt: Date;
  reviewStartsAt: Date | null;
  reviewEndsAt: Date | null;
  message: string | null;
  season: number;
  week: number;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
  failureReason: string | null;
  notifyLeagueChat: boolean;
  notifyDm: boolean;
  leagueChatMode: LeagueChatMode;
}

export interface TradeItem {
  id: number;
  tradeId: number;
  itemType: TradeItemType;
  // Player fields (when itemType = 'player')
  playerId: number | null;
  playerName: string | null;
  playerPosition: string | null;
  playerTeam: string | null;
  // Pick fields (when itemType = 'draft_pick')
  draftPickAssetId: number | null;
  pickSeason: number | null;
  pickRound: number | null;
  pickOriginalTeam: string | null;
  // Common fields
  fromRosterId: number;
  toRosterId: number;
  createdAt: Date;
}

export interface TradeVote {
  id: number;
  tradeId: number;
  rosterId: number;
  vote: 'approve' | 'veto';
  createdAt: Date;
}

/**
 * Extended trade with items and user/team metadata
 */
export interface TradeWithDetails extends Trade {
  items: TradeItemWithPlayer[];
  proposerTeamName: string;
  recipientTeamName: string;
  proposerUsername: string;
  recipientUsername: string;
  votes?: TradeVoteWithUser[];
  canRespond?: boolean;
  canCancel?: boolean;
  canVote?: boolean;
}

export interface TradeItemWithPlayer extends TradeItem {
  fullName: string;
  position: string | null;
  team: string | null;
  status: string | null;
}

export interface TradeVoteWithUser extends TradeVote {
  username: string;
  teamName: string;
}

/**
 * Request DTOs
 */
export interface ProposeTradeRequest {
  recipientRosterId: number;
  offeringPlayerIds: number[];
  requestingPlayerIds: number[];
  offeringPickAssetIds?: number[];
  requestingPickAssetIds?: number[];
  message?: string;
  notifyLeagueChat?: boolean;
  notifyDm?: boolean;
  leagueChatMode?: LeagueChatMode;
}

export interface CounterTradeRequest {
  offeringPlayerIds: number[];
  requestingPlayerIds: number[];
  offeringPickAssetIds?: number[];
  requestingPickAssetIds?: number[];
  message?: string;
  notifyDm?: boolean;
  leagueChatMode?: LeagueChatMode;
}

/**
 * Convert database row to Trade
 */
export function tradeFromDatabase(row: any): Trade {
  return {
    id: row.id,
    leagueId: row.league_id,
    proposerRosterId: row.proposer_roster_id,
    recipientRosterId: row.recipient_roster_id,
    status: row.status,
    parentTradeId: row.parent_trade_id,
    expiresAt: row.expires_at,
    reviewStartsAt: row.review_starts_at,
    reviewEndsAt: row.review_ends_at,
    message: row.message,
    season: row.season,
    week: row.week,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    failureReason: row.failure_reason || null,
    notifyLeagueChat: row.notify_league_chat ?? true,
    notifyDm: row.notify_dm ?? true,
    leagueChatMode: row.league_chat_mode ?? 'summary',
  };
}

/**
 * Convert Trade to API response (snake_case)
 */
export function tradeToResponse(trade: Trade): Record<string, any> {
  return {
    id: trade.id,
    league_id: trade.leagueId,
    proposer_roster_id: trade.proposerRosterId,
    recipient_roster_id: trade.recipientRosterId,
    status: trade.status,
    parent_trade_id: trade.parentTradeId,
    expires_at: trade.expiresAt,
    review_starts_at: trade.reviewStartsAt,
    review_ends_at: trade.reviewEndsAt,
    message: trade.message,
    season: trade.season,
    week: trade.week,
    created_at: trade.createdAt,
    updated_at: trade.updatedAt,
    completed_at: trade.completedAt,
    failure_reason: trade.failureReason,
    notify_league_chat: trade.notifyLeagueChat,
    notify_dm: trade.notifyDm,
    league_chat_mode: trade.leagueChatMode,
  };
}

/**
 * Convert database row to TradeItem
 */
export function tradeItemFromDatabase(row: any): TradeItem {
  return {
    id: row.id,
    tradeId: row.trade_id,
    itemType: row.item_type || 'player',
    playerId: row.player_id,
    playerName: row.player_name,
    playerPosition: row.player_position,
    playerTeam: row.player_team,
    draftPickAssetId: row.draft_pick_asset_id,
    pickSeason: row.pick_season,
    pickRound: row.pick_round,
    pickOriginalTeam: row.pick_original_team,
    fromRosterId: row.from_roster_id,
    toRosterId: row.to_roster_id,
    createdAt: row.created_at,
  };
}

/**
 * Convert TradeItem to API response
 */
export function tradeItemToResponse(item: TradeItem): Record<string, any> {
  return {
    id: item.id,
    trade_id: item.tradeId,
    item_type: item.itemType,
    player_id: item.playerId,
    player_name: item.playerName,
    player_position: item.playerPosition,
    player_team: item.playerTeam,
    draft_pick_asset_id: item.draftPickAssetId,
    pick_season: item.pickSeason,
    pick_round: item.pickRound,
    pick_original_team: item.pickOriginalTeam,
    from_roster_id: item.fromRosterId,
    to_roster_id: item.toRosterId,
    created_at: item.createdAt,
  };
}

/**
 * Convert database row to TradeVote
 */
export function tradeVoteFromDatabase(row: any): TradeVote {
  return {
    id: row.id,
    tradeId: row.trade_id,
    rosterId: row.roster_id,
    vote: row.vote,
    createdAt: row.created_at,
  };
}

/**
 * Convert TradeWithDetails to API response
 */
export function tradeWithDetailsToResponse(trade: TradeWithDetails): Record<string, any> {
  return {
    ...tradeToResponse(trade),
    items: trade.items.map((item) => ({
      ...tradeItemToResponse(item),
      full_name: item.fullName,
      position: item.position,
      team: item.team,
      status: item.status,
    })),
    proposer_team_name: trade.proposerTeamName,
    recipient_team_name: trade.recipientTeamName,
    proposer_username: trade.proposerUsername,
    recipient_username: trade.recipientUsername,
    votes: trade.votes?.map((v) => ({
      id: v.id,
      trade_id: v.tradeId,
      roster_id: v.rosterId,
      vote: v.vote,
      username: v.username,
      team_name: v.teamName,
      created_at: v.createdAt,
    })),
    can_respond: trade.canRespond,
    can_cancel: trade.canCancel,
    can_vote: trade.canVote,
  };
}
