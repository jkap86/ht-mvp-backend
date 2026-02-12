import { Router } from 'express';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import { ChatReactionRepository } from './chat-reaction.repository';
import { LeagueRepository } from '../leagues/leagues.repository';
import { authMiddleware } from '../../middleware/auth.middleware';
import { validateRequest } from '../../middleware/validation.middleware';
import { dmMessageLimiter, dmReadLimiter } from '../../middleware/rate-limit.middleware';
import { container, KEYS } from '../../container';
import { sendMessageSchema, getMessagesQuerySchema, reactionSchema } from './chat.schemas';
import { asyncHandler } from '../../shared/async-handler';

// Resolve dependencies from container
const chatService = container.resolve<ChatService>(KEYS.CHAT_SERVICE);
const chatReactionRepo = container.resolve<ChatReactionRepository>(KEYS.CHAT_REACTION_REPO);
const leagueRepo = container.resolve<LeagueRepository>(KEYS.LEAGUE_REPO);
const chatController = new ChatController(chatService, chatReactionRepo, leagueRepo);

const router = Router({ mergeParams: true }); // mergeParams to access :leagueId

// All chat routes require authentication
router.use(authMiddleware);

// GET /api/leagues/:leagueId/chat?limit=50&before=123
router.get('/', dmReadLimiter, validateRequest(getMessagesQuerySchema, 'query'), asyncHandler(chatController.getMessages));

// POST /api/leagues/:leagueId/chat
router.post('/', dmMessageLimiter, validateRequest(sendMessageSchema), asyncHandler(chatController.sendMessage));

// POST /api/leagues/:leagueId/chat/:messageId/reactions
router.post('/:messageId/reactions', dmMessageLimiter, validateRequest(reactionSchema), asyncHandler(chatController.addReaction));

// DELETE /api/leagues/:leagueId/chat/:messageId/reactions
router.delete('/:messageId/reactions', dmMessageLimiter, validateRequest(reactionSchema), asyncHandler(chatController.removeReaction));

export default router;
