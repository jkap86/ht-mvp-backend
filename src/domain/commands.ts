/**
 * Command Types and Payloads
 *
 * This module defines the command structure for the domain mutation gateway.
 * Commands represent intent to perform domain mutations and are dispatched
 * through the CommandBus for centralized handling.
 */

/**
 * Base command interface. All domain mutations flow through commands.
 */
export interface Command<T = unknown> {
  /** Command type identifier */
  type: string;
  /** Command-specific payload */
  payload: T;
  /** Actor who initiated the command */
  actor: CommandActor;
  /** Optional metadata for tracing and idempotency */
  metadata?: CommandMetadata;
}

/**
 * Information about who initiated the command
 */
export interface CommandActor {
  /** User ID (null for system/job-initiated commands) */
  userId: string | null;
  /** Client IP address (optional, for audit) */
  ip?: string;
  /** User agent string (optional, for audit) */
  userAgent?: string;
}

/**
 * Optional metadata for tracing and idempotency
 */
export interface CommandMetadata {
  /** Idempotency key to prevent duplicate processing */
  idempotencyKey?: string;
  /** Correlation ID for distributed tracing */
  correlationId?: string;
  /** Request ID from the originating HTTP request */
  requestId?: string;
}

/**
 * Command type constants for type-safe command dispatching.
 * Organized by domain area.
 */
export const CommandTypes = {
  // ============ Draft Commands ============
  /** Make a player pick in a draft */
  DRAFT_MAKE_PICK: 'draft:makePick',
  /** Make a pick asset selection (vet drafts) */
  DRAFT_MAKE_PICK_ASSET_SELECTION: 'draft:makePickAssetSelection',
  /** System-initiated auto pick */
  DRAFT_AUTO_PICK: 'draft:autoPick',
  /** Handle pick timeout */
  DRAFT_TIMEOUT: 'draft:timeout',
  /** Start a draft */
  DRAFT_START: 'draft:start',
  /** Pause a draft */
  DRAFT_PAUSE: 'draft:pause',
  /** Resume a paused draft */
  DRAFT_RESUME: 'draft:resume',
  /** Manually complete a draft */
  DRAFT_COMPLETE: 'draft:complete',
  /** Undo the last pick */
  DRAFT_UNDO_PICK: 'draft:undoPick',
  /** Update draft settings */
  DRAFT_UPDATE_SETTINGS: 'draft:updateSettings',

  // ============ Auction Commands ============
  /** Place a bid in slow auction */
  AUCTION_PLACE_BID: 'auction:placeBid',
  /** Set max bid in fast auction */
  AUCTION_SET_MAX_BID: 'auction:setMaxBid',
  /** Nominate a player */
  AUCTION_NOMINATE: 'auction:nominate',
  /** Pass on nomination */
  AUCTION_PASS: 'auction:pass',

  // ============ Trade Commands ============
  /** Propose a new trade */
  TRADE_PROPOSE: 'trade:propose',
  /** Accept a pending trade */
  TRADE_ACCEPT: 'trade:accept',
  /** Reject a pending trade */
  TRADE_REJECT: 'trade:reject',
  /** Cancel a proposed trade */
  TRADE_CANCEL: 'trade:cancel',
  /** Counter a trade with modifications */
  TRADE_COUNTER: 'trade:counter',
  /** Cast a vote on a trade */
  TRADE_VOTE: 'trade:vote',

  // ============ Waiver Commands ============
  /** Submit a waiver claim */
  WAIVER_SUBMIT_CLAIM: 'waiver:submitClaim',
  /** Cancel a pending claim */
  WAIVER_CANCEL_CLAIM: 'waiver:cancelClaim',
  /** Reorder waiver claims */
  WAIVER_REORDER_CLAIMS: 'waiver:reorderClaims',
  /** Process waivers for a league (system command) */
  WAIVER_PROCESS_LEAGUE: 'waiver:processLeague',

  // ============ Roster Commands ============
  /** Add a player to roster (free agent pickup) */
  ROSTER_ADD_PLAYER: 'roster:addPlayer',
  /** Drop a player from roster */
  ROSTER_DROP_PLAYER: 'roster:dropPlayer',
  /** Add/drop in single transaction */
  ROSTER_ADD_DROP: 'roster:addDrop',

  // ============ Lineup Commands ============
  /** Set lineup for a week */
  LINEUP_SET: 'lineup:set',
  /** Swap players in lineup */
  LINEUP_SWAP: 'lineup:swap',

  // ============ Playoff Commands ============
  /** Generate playoff bracket */
  PLAYOFF_GENERATE_BRACKET: 'playoff:generateBracket',
  /** Advance playoff winners */
  PLAYOFF_ADVANCE_WINNERS: 'playoff:advanceWinners',
  /** Finalize playoff bracket */
  PLAYOFF_FINALIZE: 'playoff:finalize',
} as const;

export type CommandType = (typeof CommandTypes)[keyof typeof CommandTypes];

// ============ Draft Command Payloads ============

export interface DraftMakePickPayload {
  leagueId: number;
  draftId: number;
  playerId: number;
}

export interface DraftMakePickAssetPayload {
  leagueId: number;
  draftId: number;
  draftPickAssetId: number;
}

export interface DraftAutoPickPayload {
  draftId: number;
  reason: 'timeout' | 'autodraft' | 'empty_queue';
}

export interface DraftTimeoutPayload {
  draftId: number;
}

export interface DraftStartPayload {
  leagueId: number;
  draftId: number;
}

export interface DraftPausePayload {
  leagueId: number;
  draftId: number;
}

export interface DraftResumePayload {
  leagueId: number;
  draftId: number;
}

export interface DraftCompletePayload {
  leagueId: number;
  draftId: number;
}

export interface DraftUndoPickPayload {
  leagueId: number;
  draftId: number;
}

// ============ Auction Command Payloads ============

export interface AuctionPlaceBidPayload {
  leagueId: number;
  draftId: number;
  lotId: number;
  bidAmount: number;
}

export interface AuctionSetMaxBidPayload {
  leagueId: number;
  draftId: number;
  lotId: number;
  maxBid: number;
}

export interface AuctionNominatePayload {
  leagueId: number;
  draftId: number;
  playerId: number;
  openingBid?: number;
}

// ============ Trade Command Payloads ============

export interface TradeProposePayload {
  leagueId: number;
  recipientRosterId: number;
  proposerItems: TradeItemPayload[];
  recipientItems: TradeItemPayload[];
  message?: string;
}

export interface TradeItemPayload {
  playerId?: number;
  draftPickAssetId?: number;
}

export interface TradeAcceptPayload {
  tradeId: number;
}

export interface TradeRejectPayload {
  tradeId: number;
  reason?: string;
}

export interface TradeCancelPayload {
  tradeId: number;
}

export interface TradeCounterPayload {
  tradeId: number;
  proposerItems: TradeItemPayload[];
  recipientItems: TradeItemPayload[];
  message?: string;
}

export interface TradeVotePayload {
  tradeId: number;
  vote: 'approve' | 'reject';
}

// ============ Waiver Command Payloads ============

export interface WaiverSubmitClaimPayload {
  leagueId: number;
  playerId: number;
  dropPlayerId?: number;
  bidAmount?: number;
}

export interface WaiverCancelClaimPayload {
  leagueId: number;
  claimId: number;
}

export interface WaiverReorderClaimsPayload {
  leagueId: number;
  claimIds: number[];
}

export interface WaiverProcessLeaguePayload {
  leagueId: number;
  season: number;
  week: number;
}

// ============ Roster Command Payloads ============

export interface RosterAddPlayerPayload {
  leagueId: number;
  playerId: number;
}

export interface RosterDropPlayerPayload {
  leagueId: number;
  playerId: number;
}

export interface RosterAddDropPayload {
  leagueId: number;
  addPlayerId: number;
  dropPlayerId: number;
}

// ============ Lineup Command Payloads ============

export interface LineupSetPayload {
  leagueId: number;
  rosterId: number;
  week: number;
  starters: number[];
}

export interface LineupSwapPayload {
  leagueId: number;
  rosterId: number;
  week: number;
  playerId1: number;
  playerId2: number;
}

// ============ Playoff Command Payloads ============

export interface PlayoffGenerateBracketPayload {
  leagueId: number;
  season: number;
  playoffTeams: number;
  startWeek: number;
  weeksByRound?: number[];
  enableThirdPlace?: boolean;
  consolationType?: 'NONE' | 'CONSOLATION';
  consolationTeams?: number;
}

export interface PlayoffAdvanceWinnersPayload {
  leagueId: number;
  week: number;
}

export interface PlayoffFinalizePayload {
  leagueId: number;
  season: number;
}

// ============ Type-safe Command Creators ============

/**
 * Helper to create a typed command with proper structure
 */
export function createCommand<T>(
  type: CommandType,
  payload: T,
  actor: CommandActor,
  metadata?: CommandMetadata
): Command<T> {
  return { type, payload, actor, metadata };
}
