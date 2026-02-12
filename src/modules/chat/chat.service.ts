import { ChatRepository } from './chat.repository';
import { messageToResponse } from './chat.model';
import type { LeagueRepository } from '../leagues/leagues.repository';
import { ForbiddenException, ValidationException } from '../../utils/exceptions';
import { EventTypes, tryGetEventBus } from '../../shared/events';

export class ChatService {
  constructor(
    private readonly chatRepo: ChatRepository,
    private readonly leagueRepo: LeagueRepository
  ) {}

  async sendMessage(leagueId: number, userId: string, message: string): Promise<any> {
    // Verify user is member
    const isMember = await this.leagueRepo.isUserMember(leagueId, userId);
    if (!isMember) {
      throw new ForbiddenException('You are not a member of this league');
    }

    // Validate message
    if (!message || message.trim().length === 0) {
      throw new ValidationException('Message cannot be empty');
    }

    if (message.length > 1500) {
      throw new ValidationException('Message cannot exceed 1500 characters');
    }

    const msg = await this.chatRepo.create(leagueId, userId, message.trim());
    const response = messageToResponse(msg);

    // Emit event via domain event bus
    const eventBus = tryGetEventBus();
    eventBus?.publish({
      type: EventTypes.CHAT_MESSAGE,
      leagueId,
      payload: response,
    });

    return response;
  }

  async getMessages(
    leagueId: number,
    userId: string,
    limit?: number,
    before?: number,
    aroundTimestamp?: string
  ): Promise<any[]> {
    // Verify user is member
    const isMember = await this.leagueRepo.isUserMember(leagueId, userId);
    if (!isMember) {
      throw new ForbiddenException('You are not a member of this league');
    }

    // Handle timestamp-based query (for date jump navigation)
    if (aroundTimestamp) {
      const timestamp = new Date(aroundTimestamp);
      if (isNaN(timestamp.getTime())) {
        throw new ValidationException('Invalid timestamp');
      }
      const messages = await this.chatRepo.getMessagesAroundTimestamp(leagueId, timestamp, limit);
      return messages.map(messageToResponse);
    }

    // Handle regular pagination
    const messages = await this.chatRepo.findByLeagueId(leagueId, limit, before);
    return messages.map(messageToResponse);
  }

  async searchMessages(
    leagueId: number,
    userId: string,
    searchQuery: string,
    limit = 100,
    offset = 0
  ): Promise<{ messages: any[]; total: number }> {
    // Verify user is member
    const isMember = await this.leagueRepo.isUserMember(leagueId, userId);
    if (!isMember) {
      throw new ForbiddenException('You are not a member of this league');
    }

    // Validate search query
    if (!searchQuery || searchQuery.trim().length === 0) {
      throw new ValidationException('Search query cannot be empty');
    }

    const result = await this.chatRepo.searchMessages(leagueId, searchQuery.trim(), limit, offset);
    return {
      messages: result.messages.map(messageToResponse),
      total: result.total,
    };
  }
}
