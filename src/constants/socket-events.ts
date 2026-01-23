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
    LOT_CREATED: 'auction:lot_created',
    LOT_UPDATED: 'auction:lot_updated',
    LOT_WON: 'auction:lot_won',
    OUTBID: 'auction:outbid',
  },
} as const;

// Room name helpers
export const ROOM_NAMES = {
  league: (leagueId: number) => `league:${leagueId}`,
  draft: (draftId: number) => `draft:${draftId}`,
} as const;
