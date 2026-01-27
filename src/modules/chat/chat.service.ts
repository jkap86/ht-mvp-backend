import { ChatRepository } from './chat.repository';
import { ChatMessageWithUser, messageToResponse } from './chat.model';
import { LeagueRepository } from '../leagues/leagues.repository';
import { ForbiddenException, ValidationException } from '../../utils/exceptions';
import { tryGetSocketService } from '../../socket';

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

    if (message.length > 1000) {
      throw new ValidationException('Message cannot exceed 1000 characters');
    }

    const msg = await this.chatRepo.create(leagueId, userId, message.trim());
    const response = messageToResponse(msg);

    // Emit socket event
    const socket = tryGetSocketService();
    socket?.emitChatMessage(leagueId, response);

    return response;
  }

  async getMessages(leagueId: number, userId: string, limit?: number, before?: number): Promise<any[]> {
    // Verify user is member
    const isMember = await this.leagueRepo.isUserMember(leagueId, userId);
    if (!isMember) {
      throw new ForbiddenException('You are not a member of this league');
    }

    const messages = await this.chatRepo.findByLeagueId(leagueId, limit, before);
    return messages.map(messageToResponse);
  }
}
