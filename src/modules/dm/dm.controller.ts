import { Response, NextFunction } from 'express';
import { AuthRequest } from '../../middleware/auth.middleware';
import { DmService } from './dm.service';
import { DmReactionRepository, groupDmReactions } from './dm-reaction.repository';
import { requireUserId } from '../../utils/controller-helpers';
import { ValidationException, ForbiddenException } from '../../utils/exceptions';
import { EventTypes, tryGetEventBus } from '../../shared/events';

/**
 * Parse and validate conversation ID from request params
 */
function requireConversationId(req: AuthRequest): number {
  const rawId = req.params.conversationId;
  const conversationId = parseInt(Array.isArray(rawId) ? rawId[0] : rawId, 10);
  if (isNaN(conversationId) || conversationId <= 0) {
    throw new ValidationException('Invalid conversation ID');
  }
  return conversationId;
}

/**
 * Parse and validate limit query parameter
 */
function parseLimit(value: string | undefined, defaultValue = 50, max = 100): number {
  if (!value) return defaultValue;
  const parsed = parseInt(value, 10);
  if (isNaN(parsed) || parsed <= 0) return defaultValue;
  return Math.min(parsed, max);
}

/**
 * Parse and validate before query parameter for pagination
 */
function parseBefore(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = parseInt(value, 10);
  if (isNaN(parsed) || parsed <= 0) return undefined;
  return parsed;
}

export class DmController {
  constructor(
    private readonly dmService: DmService,
    private readonly dmReactionRepo: DmReactionRepository
  ) {}

  /**
   * GET /api/dm
   * List all conversations for the authenticated user
   */
  getConversations = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = requireUserId(req);
      const conversations = await this.dmService.getConversations(userId);
      res.status(200).json(conversations);
    } catch (error) {
      next(error);
    }
  };

  /**
   * POST /api/dm/user/:otherUserId
   * Get or create a conversation with another user
   */
  getOrCreateConversation = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = requireUserId(req);
      const rawOtherUserId = req.params.otherUserId;
      const otherUserId = Array.isArray(rawOtherUserId) ? rawOtherUserId[0] : rawOtherUserId;
      if (!otherUserId || otherUserId.trim() === '') {
        throw new ValidationException('Other user ID is required');
      }
      const conversation = await this.dmService.getOrCreateConversation(userId, otherUserId);
      res.status(201).json(conversation);
    } catch (error) {
      next(error);
    }
  };

  /**
   * GET /api/dm/:conversationId/messages
   * Get messages for a conversation with pagination
   */
  getMessages = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = requireUserId(req);
      const conversationId = requireConversationId(req);
      const limit = parseLimit(req.query.limit as string);
      const before = parseBefore(req.query.before as string);

      const messages = await this.dmService.getMessages(userId, conversationId, limit, before);

      // Attach reactions to messages
      const messageIds = messages.map((m: any) => m.id);
      const reactionsMap = await this.dmReactionRepo.getReactionsForMessages(messageIds);

      const messagesWithReactions = messages.map((m: any) => ({
        ...m,
        reactions: groupDmReactions(reactionsMap.get(m.id) || []),
      }));

      res.status(200).json(messagesWithReactions);
    } catch (error) {
      next(error);
    }
  };

  /**
   * POST /api/dm/:conversationId/messages
   * Send a message in a conversation
   */
  sendMessage = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = requireUserId(req);
      const conversationId = requireConversationId(req);
      const { message } = req.body;

      if (typeof message !== 'string') {
        throw new ValidationException('Message must be a string');
      }

      const msg = await this.dmService.sendMessage(userId, conversationId, message);
      res.status(201).json(msg);
    } catch (error) {
      next(error);
    }
  };

  /**
   * PUT /api/dm/:conversationId/read
   * Mark a conversation as read
   */
  markAsRead = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = requireUserId(req);
      const conversationId = requireConversationId(req);

      await this.dmService.markAsRead(userId, conversationId);
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  };

  /**
   * GET /api/dm/unread-count
   * Get total unread message count for badge display
   */
  getUnreadCount = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = requireUserId(req);
      const count = await this.dmService.getTotalUnreadCount(userId);
      res.status(200).json({ unread_count: count });
    } catch (error) {
      next(error);
    }
  };

  /**
   * POST /api/dm/:conversationId/messages/:messageId/reactions
   */
  addReaction = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = requireUserId(req);
      const conversationId = requireConversationId(req);
      const messageId = parseInt(req.params.messageId, 10);
      if (isNaN(messageId) || messageId <= 0) {
        throw new ValidationException('Invalid message ID');
      }

      const { emoji } = req.body;

      // Verify message belongs to this conversation
      const msgConvId = await this.dmReactionRepo.getMessageConversationId(messageId);
      if (msgConvId !== conversationId) {
        throw new ForbiddenException('Message does not belong to this conversation');
      }

      const added = await this.dmReactionRepo.addReaction(messageId, userId, emoji);
      if (!added) {
        return res.status(200).json({ message: 'Already reacted' });
      }

      // Emit reaction event to the other user
      const conversation = await this.dmService.getConversationById(conversationId);
      if (conversation) {
        const otherUserId = conversation.user1Id === userId
          ? conversation.user2Id
          : conversation.user1Id;

        const eventBus = tryGetEventBus();
        eventBus?.publish({
          type: EventTypes.DM_REACTION_ADDED,
          userId: otherUserId,
          payload: { conversationId, messageId, userId, emoji },
        });
      }

      res.status(201).json({ messageId, userId, emoji });
    } catch (error) {
      next(error);
    }
  };

  /**
   * DELETE /api/dm/:conversationId/messages/:messageId/reactions
   */
  removeReaction = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = requireUserId(req);
      const conversationId = requireConversationId(req);
      const messageId = parseInt(req.params.messageId, 10);
      if (isNaN(messageId) || messageId <= 0) {
        throw new ValidationException('Invalid message ID');
      }

      const { emoji } = req.body;

      // Verify message belongs to this conversation
      const msgConvId = await this.dmReactionRepo.getMessageConversationId(messageId);
      if (msgConvId !== conversationId) {
        throw new ForbiddenException('Message does not belong to this conversation');
      }

      const removed = await this.dmReactionRepo.removeReaction(messageId, userId, emoji);
      if (!removed) {
        return res.status(200).json({ message: 'Reaction not found' });
      }

      // Emit reaction event to the other user
      const conversation = await this.dmService.getConversationById(conversationId);
      if (conversation) {
        const otherUserId = conversation.user1Id === userId
          ? conversation.user2Id
          : conversation.user1Id;

        const eventBus = tryGetEventBus();
        eventBus?.publish({
          type: EventTypes.DM_REACTION_REMOVED,
          userId: otherUserId,
          payload: { conversationId, messageId, userId, emoji },
        });
      }

      res.status(200).json({ messageId, userId, emoji });
    } catch (error) {
      next(error);
    }
  };
}
