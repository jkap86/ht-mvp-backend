/**
 * Socket.IO event name constants.
 * Use these instead of hardcoded strings for type safety and consistency.
 */

export const SOCKET_EVENTS = {
  // App-level events
  APP: {
    ERROR: 'app:error',
  },

  // League events
  LEAGUE: {
    JOIN: 'join:league',
    LEAVE: 'leave:league',
  },

  // Draft events
  DRAFT: {
    JOIN: 'join:draft',
    LEAVE: 'leave:draft',
    USER_JOINED: 'draft:user_joined',
    USER_LEFT: 'draft:user_left',
    PICK_MADE: 'draft:pick_made',
    PICK_UNDONE: 'draft:pick_undone',
    STARTED: 'draft:started',
    PAUSED: 'draft:paused',
    RESUMED: 'draft:resumed',
    COMPLETED: 'draft:completed',
    NEXT_PICK: 'draft:next_pick',
    QUEUE_UPDATED: 'draft:queue_updated',
  },

  // Chat events
  CHAT: {
    MESSAGE: 'chat:message',
  },

  // Auction events
  AUCTION: {
    LOT_CREATED: 'draft:auction_lot_created',
    LOT_UPDATED: 'draft:auction_lot_updated',
    LOT_WON: 'draft:auction_lot_won',
    LOT_PASSED: 'draft:auction_lot_passed',
    OUTBID: 'draft:auction_outbid',
    NOMINATOR_CHANGED: 'draft:auction_nominator_changed',
    ERROR: 'draft:auction_error',
  },

  // Trade events
  TRADE: {
    PROPOSED: 'trade:proposed',
    ACCEPTED: 'trade:accepted',
    REJECTED: 'trade:rejected',
    COUNTERED: 'trade:countered',
    CANCELLED: 'trade:cancelled',
    EXPIRED: 'trade:expired',
    COMPLETED: 'trade:completed',
    VETOED: 'trade:vetoed',
    VOTE_CAST: 'trade:vote_cast',
    INVALIDATED: 'trade:invalidated',
  },

  // Waiver events
  WAIVER: {
    CLAIM_SUBMITTED: 'waiver:claim_submitted',
    CLAIM_CANCELLED: 'waiver:claim_cancelled',
    CLAIM_UPDATED: 'waiver:claim_updated',
    PROCESSED: 'waiver:processed',
    CLAIM_SUCCESSFUL: 'waiver:claim_successful',
    CLAIM_FAILED: 'waiver:claim_failed',
    PRIORITY_UPDATED: 'waiver:priority_updated',
    BUDGET_UPDATED: 'waiver:budget_updated',
  },
} as const;

// Room name helpers
export const ROOM_NAMES = {
  league: (leagueId: number) => `league:${leagueId}`,
  draft: (draftId: number) => `draft:${draftId}`,
} as const;
