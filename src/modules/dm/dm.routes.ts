import { Router } from 'express';
import { DmController } from './dm.controller';
import { DmService } from './dm.service';
import { authMiddleware } from '../../middleware/auth.middleware';
import { dmMessageLimiter } from '../../middleware/rate-limit.middleware';
import { container, KEYS } from '../../container';

// Resolve dependencies from container
const dmService = container.resolve<DmService>(KEYS.DM_SERVICE);
const dmController = new DmController(dmService);

const router = Router();

// All DM routes require authentication
router.use(authMiddleware);

// GET /api/dm - List all conversations
router.get('/', dmController.getConversations);

// GET /api/dm/unread-count - Get total unread count (must be before :conversationId route)
router.get('/unread-count', dmController.getUnreadCount);

// POST /api/dm/user/:otherUserId - Get or create conversation with a user
router.post('/user/:otherUserId', dmController.getOrCreateConversation);

// GET /api/dm/:conversationId/messages - Get messages for a conversation
router.get('/:conversationId/messages', dmController.getMessages);

// POST /api/dm/:conversationId/messages - Send a message (rate limited)
router.post('/:conversationId/messages', dmMessageLimiter, dmController.sendMessage);

// PUT /api/dm/:conversationId/read - Mark conversation as read
router.put('/:conversationId/read', dmController.markAsRead);

export default router;
