import { Response, NextFunction } from 'express';
import { AuthRequest } from '../../middleware/auth.middleware';
import { DmService } from './dm.service';
import { requireUserId } from '../../utils/controller-helpers';
import { ValidationException } from '../../utils/exceptions';

/**
 * Parse and validate conversation ID from request params
 */
function requireConversationId(req: AuthRequest): number {
  const conversationId = parseInt(req.params.conversationId, 10);
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
  constructor(private readonly dmService: DmService) {}

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
      const otherUserId = req.params.otherUserId;
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
      res.status(200).json(messages);
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
}
