/**
 * Message types for league chat
 */
export type MessageType =
  | 'chat'
  | 'trade_proposed'
  | 'trade_countered'
  | 'trade_accepted'
  | 'trade_completed'
  | 'trade_rejected'
  | 'trade_cancelled'
  | 'trade_vetoed'
  | 'trade_invalidated'
  | 'waiver_successful'
  | 'waiver_processed'
  | 'settings_updated'
  | 'member_joined'
  | 'member_kicked'
  | 'dues_paid'
  | 'dues_unpaid';

/**
 * Metadata for system messages - stores event-specific details
 */
export interface SystemMessageMetadata {
  // Trade events
  tradeId?: number;
  fromTeam?: string;
  toTeam?: string;
  fromRosterId?: number;
  toRosterId?: number;
  reason?: string; // e.g., for trade_invalidated

  // Waiver events
  teamName?: string;
  playerName?: string;
  playerId?: number;
  bidAmount?: number;

  // Settings events
  settingName?: string;
  oldValue?: unknown;
  newValue?: unknown;

  // Generic
  eventType?: string;
}

export interface ChatMessage {
  id: number;
  leagueId: number;
  userId: string | null;
  message: string;
  messageType: MessageType;
  metadata: SystemMessageMetadata | null;
  createdAt: Date;
}

export interface ChatMessageWithUser extends ChatMessage {
  username: string | null;
}

/**
 * Check if a message is a system message (no user AND not 'chat' type)
 */
export function isSystemMessage(msg: ChatMessage): boolean {
  return msg.userId === null && msg.messageType !== 'chat';
}

export function messageToResponse(msg: ChatMessageWithUser): any {
  return {
    id: msg.id,
    league_id: msg.leagueId,
    user_id: msg.userId,
    username: msg.username,
    message: msg.message,
    message_type: msg.messageType,
    metadata: msg.metadata,
    created_at: msg.createdAt,
  };
}
