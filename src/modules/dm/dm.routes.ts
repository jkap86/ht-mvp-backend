import { Router } from 'express';
import { DmController } from './dm.controller';
import { DmService } from './dm.service';
import { DmReactionRepository } from './dm-reaction.repository';
import { authMiddleware } from '../../middleware/auth.middleware';
import { validateRequest } from '../../middleware/validation.middleware';
import { dmMessageLimiter, dmReadLimiter } from '../../middleware/rate-limit.middleware';
import { container, KEYS } from '../../container';
import { sendDmSchema, getDmMessagesQuerySchema, dmReactionSchema } from './dm.schemas';

// Resolve dependencies from container
const dmService = container.resolve<DmService>(KEYS.DM_SERVICE);
const dmReactionRepo = container.resolve<DmReactionRepository>(KEYS.DM_REACTION_REPO);
const dmController = new DmController(dmService, dmReactionRepo);

const router = Router();

// All DM routes require authentication
router.use(authMiddleware);

// GET /api/dm - List all conversations (rate limited)
router.get('/', dmReadLimiter, dmController.getConversations);

// GET /api/dm/unread-count - Get total unread count (must be before :conversationId route)
router.get('/unread-count', dmReadLimiter, dmController.getUnreadCount);

// POST /api/dm/user/:otherUserId - Get or create conversation with a user
router.post('/user/:otherUserId', dmReadLimiter, dmController.getOrCreateConversation);

// GET /api/dm/:conversationId/messages - Get messages for a conversation
router.get('/:conversationId/messages', dmReadLimiter, validateRequest(getDmMessagesQuerySchema, 'query'), dmController.getMessages);

// POST /api/dm/:conversationId/messages - Send a message (stricter rate limit)
router.post('/:conversationId/messages', dmMessageLimiter, validateRequest(sendDmSchema), dmController.sendMessage);

// PUT /api/dm/:conversationId/read - Mark conversation as read
router.put('/:conversationId/read', dmReadLimiter, dmController.markAsRead);

// POST /api/dm/:conversationId/messages/:messageId/reactions
router.post('/:conversationId/messages/:messageId/reactions', dmMessageLimiter, validateRequest(dmReactionSchema), dmController.addReaction);

// DELETE /api/dm/:conversationId/messages/:messageId/reactions
router.delete('/:conversationId/messages/:messageId/reactions', dmReadLimiter, validateRequest(dmReactionSchema), dmController.removeReaction);

export default router;
