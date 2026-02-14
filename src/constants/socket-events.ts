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
    SETTINGS_UPDATED: 'league:settings_updated',
    WEEK_ADVANCED: 'league:week_advanced',
    SEASON_ROLLED_OVER: 'league:seasonRolledOver',
  },

  // Draft events
  DRAFT: {
    JOIN: 'join:draft',
    LEAVE: 'leave:draft',
    USER_JOINED: 'draft:user_joined',
    USER_LEFT: 'draft:user_left',
    PICK_MADE: 'draft:pick_made',
    PICK_UNDONE: 'draft:pick_undone',
    PICK_TRADED: 'draft:pick_traded',
    CREATED: 'draft:created',
    STARTED: 'draft:started',
    PAUSED: 'draft:paused',
    RESUMED: 'draft:resumed',
    COMPLETED: 'draft:completed',
    NEXT_PICK: 'draft:next_pick',
    QUEUE_UPDATED: 'draft:queue_updated',
    AUTODRAFT_TOGGLED: 'draft:autodraft_toggled',
    SETTINGS_UPDATED: 'draft:settings_updated',
  },

  // Chat events
  CHAT: {
    MESSAGE: 'chat:message',
    REACTION_ADDED: 'chat:reaction_added',
    REACTION_REMOVED: 'chat:reaction_removed',
  },

  // Direct message events
  DM: {
    MESSAGE: 'dm:message',
    READ: 'dm:read',
    REACTION_ADDED: 'dm:reaction_added',
    REACTION_REMOVED: 'dm:reaction_removed',
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

  // Derby events (draft order selection phase)
  DERBY: {
    STATE: 'derby:state',
    SLOT_PICKED: 'derby:slot_picked',
    TURN_CHANGED: 'derby:turn_changed',
    PHASE_TRANSITION: 'derby:phase_transition',
  },

  // Trade events
  TRADE: {
    PROPOSED: 'trade:proposed',
    ACCEPTED: 'trade:accepted',
    REJECTED: 'trade:rejected',
    COUNTERED: 'trade:countered',
    CANCELLED: 'trade:cancelled',
    EXPIRED: 'trade:expired',
    FAILED: 'trade:failed',
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

  // Scoring events
  SCORING: {
    SCORES_UPDATED: 'scoring:scores_updated',
    WEEK_FINALIZED: 'scoring:week_finalized',
    // Enhanced scoring events (v2) - include actual score data
    SCORES_UPDATED_V2: 'scoring:scores_updated:v2',
    SCORES_DELTA: 'scoring:scores_delta',
    MATCHUP_SNAPSHOT: 'scoring:matchup_snapshot',
  },

  // Roster events
  ROSTER: {
    PLAYER_ADDED: 'roster:player_added',
    PLAYER_DROPPED: 'roster:player_dropped',
  },

  // Member events
  MEMBER: {
    KICKED: 'member:kicked',
    JOINED: 'member:joined',
    BENCHED: 'member:benched',
  },

  // Invitation events
  INVITATION: {
    RECEIVED: 'invitation:received',
    ACCEPTED: 'invitation:accepted',
    DECLINED: 'invitation:declined',
    CANCELLED: 'invitation:cancelled',
  },

  // Playoff events
  PLAYOFF: {
    BRACKET_GENERATED: 'playoff:bracket_generated',
    WINNERS_ADVANCED: 'playoff:winners_advanced',
    CHAMPION_CROWNED: 'playoff:champion_crowned',
  },
} as const;

// Room name helpers
export const ROOM_NAMES = {
  league: (leagueId: number) => `league:${leagueId}`,
  draft: (draftId: number) => `draft:${draftId}`,
  user: (userId: string) => `user:${userId}`,
} as const;
