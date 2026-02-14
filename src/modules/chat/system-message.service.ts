import { PoolClient } from 'pg';
import { ChatRepository } from './chat.repository';
import {
  ChatMessageWithUser,
  MessageType,
  SystemMessageMetadata,
  messageToResponse,
} from './chat.model';
import { EventTypes, tryGetEventBus } from '../../shared/events';

/**
 * Message templates for system messages
 */
const TEMPLATES: Record<MessageType, (m: SystemMessageMetadata) => string> = {
  chat: () => '', // Not used for system messages
  trade_proposed: (m) => `${m.fromTeam} proposed a trade to ${m.toTeam}`,
  trade_countered: (m) => `${m.fromTeam} countered a trade to ${m.toTeam}`,
  trade_accepted: (m) => `Trade accepted: ${m.fromTeam} ↔ ${m.toTeam}`,
  trade_completed: (m) => `Trade completed: ${m.fromTeam} ↔ ${m.toTeam}`,
  trade_rejected: (m) => `${m.toTeam} rejected trade from ${m.fromTeam}`,
  trade_cancelled: (m) => `${m.fromTeam} cancelled their trade offer to ${m.toTeam}`,
  trade_vetoed: (m) => `Trade vetoed: ${m.fromTeam} ↔ ${m.toTeam}`,
  trade_invalidated: (m) =>
    m.reason
      ? `Trade invalidated: ${m.fromTeam} ↔ ${m.toTeam} (${m.reason})`
      : `Trade invalidated: ${m.fromTeam} ↔ ${m.toTeam}`,
  waiver_successful: (m) =>
    m.bidAmount && m.bidAmount > 0
      ? `${m.teamName} claimed ${m.playerName} ($${m.bidAmount})`
      : `${m.teamName} claimed ${m.playerName}`,
  waiver_processed: () => `Waivers processed`,
  settings_updated: (m) => `League settings updated: ${m.settingName}`,
  member_joined: (m) => `${m.teamName} joined the league`,
  member_kicked: (m) => `${m.teamName} was removed from the league`,
  member_benched: (m) => `${m.teamName} has been benched due to league size reduction`,
  dues_paid: (m) => `${m.teamName} paid their dues`,
  dues_unpaid: (m) => `${m.teamName}'s dues payment was unmarked`,
  fa_add: (m) => `${m.teamName} added ${m.playerName} (${m.playerPosition} - ${m.playerTeam})`,
  fa_drop: (m) => `${m.teamName} dropped ${m.playerName} (${m.playerPosition} - ${m.playerTeam})`,
  fa_add_drop: (m) => `${m.teamName} added ${m.playerName} (${m.playerPosition} - ${m.playerTeam}), dropped ${m.droppedPlayerName} (${m.droppedPlayerPosition} - ${m.droppedPlayerTeam})`,
};

/**
 * Service for creating and broadcasting system messages in league chat
 */
export class SystemMessageService {
  constructor(private readonly chatRepo: ChatRepository) {}

  /**
   * Create a system message and broadcast it to the league
   */
  async createAndBroadcast(
    leagueId: number,
    messageType: MessageType,
    metadata: SystemMessageMetadata
  ): Promise<ChatMessageWithUser> {
    // Generate message from template
    const templateFn = TEMPLATES[messageType];
    if (!templateFn) {
      throw new Error(`Unknown message type: ${messageType}`);
    }

    let message = templateFn(metadata);

    // Append details if present (for trade_proposed/trade_countered with 'details' mode)
    if (metadata.details) {
      message = `${message}\n\n${metadata.details}`;
    }

    // Persist to database
    const chatMessage = await this.chatRepo.createSystemMessage(
      leagueId,
      messageType,
      message,
      metadata
    );

    // Broadcast via event bus
    this.broadcast(leagueId, chatMessage);

    return chatMessage;
  }

  /**
   * Create a system message (persist only, no broadcast)
   * Use inside transactions, then call broadcast() after commit
   */
  async create(
    leagueId: number,
    messageType: MessageType,
    metadata: SystemMessageMetadata,
    client?: PoolClient
  ): Promise<ChatMessageWithUser> {
    const templateFn = TEMPLATES[messageType];
    if (!templateFn) {
      throw new Error(`Unknown message type: ${messageType}`);
    }
    let message = templateFn(metadata);

    // Append details if present
    if (metadata.details) {
      message = `${message}\n\n${metadata.details}`;
    }

    return this.chatRepo.createSystemMessage(leagueId, messageType, message, metadata, client);
  }

  /**
   * Broadcast an already-persisted message (call AFTER commit)
   */
  broadcast(leagueId: number, message: ChatMessageWithUser): void {
    const eventBus = tryGetEventBus();
    eventBus?.publish({
      type: EventTypes.CHAT_MESSAGE,
      leagueId,
      payload: messageToResponse(message),
    });
  }
}
