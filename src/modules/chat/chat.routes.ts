import { Router } from 'express';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import { ChatRepository } from './chat.repository';
import { ChatReactionRepository } from './chat-reaction.repository';
import { LeagueRepository } from '../leagues/leagues.repository';
import { authMiddleware } from '../../middleware/auth.middleware';
import { validateRequest } from '../../middleware/validation.middleware';
import { dmMessageLimiter, dmReadLimiter } from '../../middleware/rate-limit.middleware';
import { container, KEYS } from '../../container';
import { sendMessageSchema, getMessagesQuerySchema, reactionSchema, searchMessagesQuerySchema } from './chat.schemas';
import { asyncHandler } from '../../shared/async-handler';
import { idempotencyMiddleware } from '../../middleware/idempotency.middleware';
import { Pool } from 'pg';

// Resolve dependencies from container
const chatService = container.resolve<ChatService>(KEYS.CHAT_SERVICE);
const chatReactionRepo = container.resolve<ChatReactionRepository>(KEYS.CHAT_REACTION_REPO);
const chatRepo = container.resolve<ChatRepository>(KEYS.CHAT_REPO);
const leagueRepo = container.resolve<LeagueRepository>(KEYS.LEAGUE_REPO);
const chatController = new ChatController(chatService, chatReactionRepo, leagueRepo, chatRepo);

const router = Router({ mergeParams: true }); // mergeParams to access :leagueId

// All chat routes require authentication
router.use(authMiddleware);
router.use(idempotencyMiddleware(container.resolve<Pool>(KEYS.POOL)));

// GET /api/leagues/:leagueId/chat?limit=50&before=123&around_timestamp=2026-02-01T12:00:00Z
router.get('/', dmReadLimiter, validateRequest(getMessagesQuerySchema, 'query'), asyncHandler(chatController.getMessages));

// GET /api/leagues/:leagueId/chat/search?q=trade&limit=100&offset=0
router.get('/search', dmReadLimiter, validateRequest(searchMessagesQuerySchema, 'query'), asyncHandler(chatController.searchMessages));

// POST /api/leagues/:leagueId/chat
router.post('/', dmMessageLimiter, validateRequest(sendMessageSchema), asyncHandler(chatController.sendMessage));

// POST /api/leagues/:leagueId/chat/:messageId/reactions
router.post('/:messageId/reactions', dmMessageLimiter, validateRequest(reactionSchema), asyncHandler(chatController.addReaction));

// DELETE /api/leagues/:leagueId/chat/:messageId/reactions
router.delete('/:messageId/reactions', dmMessageLimiter, validateRequest(reactionSchema), asyncHandler(chatController.removeReaction));

// POST /api/leagues/:leagueId/chat/read - Mark chat as read
router.post('/read', dmReadLimiter, asyncHandler(chatController.markAsRead));

// GET /api/leagues/:leagueId/chat/unread - Get unread count for this league
router.get('/unread', dmReadLimiter, asyncHandler(async (req: any, res: any) => {
  const userId = req.userId;
  const leagueId = parseInt(req.params.leagueId, 10);
  const count = await chatRepo.getUnreadCount(leagueId, userId);
  res.status(200).json({ unreadCount: count });
}));

export default router;
