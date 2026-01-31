import { DmRepository } from './dm.repository';
import {
  conversationToResponse,
  messageToResponse,
  ConversationWithDetails,
} from './dm.model';
import { AuthRepository } from '../auth/auth.repository';
import { ForbiddenException, ValidationException, NotFoundException } from '../../utils/exceptions';
import { tryGetSocketService } from '../../socket';

export class DmService {
  constructor(
    private readonly dmRepo: DmRepository,
    private readonly authRepo: AuthRepository
  ) {}

  /**
   * Get all conversations for a user
   */
  async getConversations(userId: string): Promise<any[]> {
    const conversations = await this.dmRepo.getConversationsForUser(userId);
    return conversations.map(conversationToResponse);
  }

  /**
   * Get or create a conversation with another user
   */
  async getOrCreateConversation(userId: string, otherUserId: string): Promise<any> {
    // Validate that the other user exists
    const otherUser = await this.authRepo.findById(otherUserId);
    if (!otherUser) {
      throw new NotFoundException('User not found');
    }

    // Cannot message yourself
    if (userId === otherUserId) {
      throw new ValidationException('Cannot start a conversation with yourself');
    }

    const conversation = await this.dmRepo.findOrCreateConversation(userId, otherUserId);

    // Build response with other user details
    const response: ConversationWithDetails = {
      id: conversation.id,
      otherUserId: otherUserId,
      otherUsername: otherUser.username,
      lastMessage: null,
      unreadCount: 0,
      updatedAt: conversation.updatedAt,
    };

    return conversationToResponse(response);
  }

  /**
   * Get messages for a conversation
   */
  async getMessages(
    userId: string,
    conversationId: number,
    limit?: number,
    before?: number
  ): Promise<any[]> {
    // Verify user is a participant
    const isParticipant = await this.dmRepo.isUserParticipant(conversationId, userId);
    if (!isParticipant) {
      throw new ForbiddenException('You are not a participant in this conversation');
    }

    const messages = await this.dmRepo.getMessages(conversationId, limit, before);
    return messages.map(messageToResponse);
  }

  /**
   * Send a message in a conversation
   */
  async sendMessage(
    userId: string,
    conversationId: number,
    message: string
  ): Promise<any> {
    // Verify user is a participant
    const isParticipant = await this.dmRepo.isUserParticipant(conversationId, userId);
    if (!isParticipant) {
      throw new ForbiddenException('You are not a participant in this conversation');
    }

    // Validate message (same rules as league chat)
    if (!message || message.trim().length === 0) {
      throw new ValidationException('Message cannot be empty');
    }

    if (message.length > 1000) {
      throw new ValidationException('Message cannot exceed 1000 characters');
    }

    const msg = await this.dmRepo.createMessage(conversationId, userId, message.trim());
    const response = messageToResponse(msg);

    // Get the conversation to find the other user
    const conversation = await this.dmRepo.findById(conversationId);
    if (conversation) {
      const otherUserId = this.dmRepo.getOtherUserId(conversation, userId);

      // Emit socket event to the other user
      const socket = tryGetSocketService();
      socket?.emitDmMessage(otherUserId, conversationId, response);
    }

    return response;
  }

  /**
   * Mark a conversation as read
   */
  async markAsRead(userId: string, conversationId: number): Promise<void> {
    // Verify user is a participant
    const isParticipant = await this.dmRepo.isUserParticipant(conversationId, userId);
    if (!isParticipant) {
      throw new ForbiddenException('You are not a participant in this conversation');
    }

    await this.dmRepo.markAsRead(conversationId, userId);

    // Optionally notify the other user that messages were read
    const conversation = await this.dmRepo.findById(conversationId);
    if (conversation) {
      const otherUserId = this.dmRepo.getOtherUserId(conversation, userId);
      const socket = tryGetSocketService();
      socket?.emitDmRead(otherUserId, conversationId, userId);
    }
  }

  /**
   * Get total unread message count for a user (for badge display)
   */
  async getTotalUnreadCount(userId: string): Promise<number> {
    const conversations = await this.dmRepo.getConversationsForUser(userId);
    return conversations.reduce((sum, conv) => sum + conv.unreadCount, 0);
  }
}
