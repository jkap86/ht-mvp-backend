import { Router } from 'express';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import { authMiddleware } from '../../middleware/auth.middleware';
import { validateRequest } from '../../middleware/validation.middleware';
import { dmMessageLimiter, dmReadLimiter } from '../../middleware/rate-limit.middleware';
import { container, KEYS } from '../../container';
import { sendMessageSchema, getMessagesQuerySchema } from './chat.schemas';

// Resolve dependencies from container
const chatService = container.resolve<ChatService>(KEYS.CHAT_SERVICE);
const chatController = new ChatController(chatService);

const router = Router({ mergeParams: true }); // mergeParams to access :leagueId

// All chat routes require authentication
router.use(authMiddleware);

// GET /api/leagues/:leagueId/chat?limit=50&before=123
router.get('/', dmReadLimiter, validateRequest(getMessagesQuerySchema, 'query'), chatController.getMessages);

// POST /api/leagues/:leagueId/chat
router.post('/', dmMessageLimiter, validateRequest(sendMessageSchema), chatController.sendMessage);

export default router;
