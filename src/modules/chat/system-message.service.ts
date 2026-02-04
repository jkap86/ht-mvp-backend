import { ChatRepository } from './chat.repository';
import {
  ChatMessageWithUser,
  MessageType,
  SystemMessageMetadata,
  messageToResponse,
} from './chat.model';
import { tryGetSocketService } from '../../socket';

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
  dues_paid: (m) => `${m.teamName} paid their dues`,
  dues_unpaid: (m) => `${m.teamName}'s dues payment was unmarked`,
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

    const message = templateFn(metadata);

    // Persist to database
    const chatMessage = await this.chatRepo.createSystemMessage(
      leagueId,
      messageType,
      message,
      metadata
    );

    // Broadcast via socket
    this.broadcastMessage(leagueId, chatMessage);

    return chatMessage;
  }

  /**
   * Broadcast a message to the league chat channel
   */
  private broadcastMessage(leagueId: number, message: ChatMessageWithUser): void {
    const socket = tryGetSocketService();
    socket?.emitChatMessage(leagueId, messageToResponse(message));
  }
}
