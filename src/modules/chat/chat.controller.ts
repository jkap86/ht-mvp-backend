import { Response, NextFunction } from 'express';
import { AuthRequest } from '../../middleware/auth.middleware';
import { ChatService } from './chat.service';
import { ChatReactionRepository, groupReactions } from './chat-reaction.repository';
import { LeagueRepository } from '../leagues/leagues.repository';
import { requireUserId, requireLeagueId } from '../../utils/controller-helpers';
import { ValidationException, ForbiddenException, NotFoundException } from '../../utils/exceptions';
import { EventTypes, tryGetEventBus } from '../../shared/events';

export class ChatController {
  constructor(
    private readonly chatService: ChatService,
    private readonly chatReactionRepo: ChatReactionRepository,
    private readonly leagueRepo: LeagueRepository
  ) {}

  getMessages = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = requireUserId(req);
      const leagueId = requireLeagueId(req);

      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;
      const before = req.query.before ? parseInt(req.query.before as string, 10) : undefined;

      const messages = await this.chatService.getMessages(leagueId, userId, limit, before);

      // Attach reactions to messages
      const messageIds = messages.map((m: any) => m.id);
      const reactionsMap = await this.chatReactionRepo.getReactionsForMessages(messageIds);

      const messagesWithReactions = messages.map((m: any) => ({
        ...m,
        reactions: groupReactions(reactionsMap.get(m.id) || [], userId),
      }));

      res.status(200).json(messagesWithReactions);
    } catch (error) {
      next(error);
    }
  };

  sendMessage = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = requireUserId(req);
      const leagueId = requireLeagueId(req);
      const { message } = req.body;

      const msg = await this.chatService.sendMessage(leagueId, userId, message);
      res.status(201).json(msg);
    } catch (error) {
      next(error);
    }
  };

  addReaction = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = requireUserId(req);
      const leagueId = requireLeagueId(req);
      const messageId = parseInt(req.params.messageId, 10);
      if (isNaN(messageId) || messageId <= 0) {
        throw new ValidationException('Invalid message ID');
      }

      const { emoji } = req.body;

      // Verify user is a member of this league
      const isMember = await this.leagueRepo.isUserMember(leagueId, userId);
      if (!isMember) {
        throw new ForbiddenException('You are not a member of this league');
      }

      // Verify message belongs to this league
      const msgLeagueId = await this.chatReactionRepo.getMessageLeagueId(messageId);
      if (msgLeagueId === null) {
        throw new NotFoundException('Message not found');
      }
      if (msgLeagueId !== leagueId) {
        throw new ForbiddenException('Message does not belong to this league');
      }

      const added = await this.chatReactionRepo.addReaction(messageId, userId, emoji);
      if (!added) {
        return res.status(200).json({ message: 'Already reacted' });
      }

      // Emit reaction event
      const eventBus = tryGetEventBus();
      eventBus?.publish({
        type: EventTypes.CHAT_REACTION_ADDED,
        leagueId,
        payload: { messageId, userId, emoji },
      });

      res.status(201).json({ messageId, userId, emoji });
    } catch (error) {
      next(error);
    }
  };

  removeReaction = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = requireUserId(req);
      const leagueId = requireLeagueId(req);
      const messageId = parseInt(req.params.messageId, 10);
      if (isNaN(messageId) || messageId <= 0) {
        throw new ValidationException('Invalid message ID');
      }

      const { emoji } = req.body;

      // Verify user is a member of this league
      const isMember = await this.leagueRepo.isUserMember(leagueId, userId);
      if (!isMember) {
        throw new ForbiddenException('You are not a member of this league');
      }

      // Verify message belongs to this league
      const msgLeagueId = await this.chatReactionRepo.getMessageLeagueId(messageId);
      if (msgLeagueId === null) {
        throw new NotFoundException('Message not found');
      }
      if (msgLeagueId !== leagueId) {
        throw new ForbiddenException('Message does not belong to this league');
      }

      const removed = await this.chatReactionRepo.removeReaction(messageId, userId, emoji);
      if (!removed) {
        return res.status(200).json({ message: 'Reaction not found' });
      }

      // Emit reaction event
      const eventBus = tryGetEventBus();
      eventBus?.publish({
        type: EventTypes.CHAT_REACTION_REMOVED,
        leagueId,
        payload: { messageId, userId, emoji },
      });

      res.status(200).json({ messageId, userId, emoji });
    } catch (error) {
      next(error);
    }
  };
}
