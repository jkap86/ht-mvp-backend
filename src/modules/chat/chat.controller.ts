import { Response, NextFunction } from 'express';
import { AuthRequest } from '../../middleware/auth.middleware';
import { ChatService } from './chat.service';
import { requireUserId, requireLeagueId } from '../../utils/controller-helpers';

export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  getMessages = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = requireUserId(req);
      const leagueId = requireLeagueId(req);

      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;
      const before = req.query.before ? parseInt(req.query.before as string, 10) : undefined;

      const messages = await this.chatService.getMessages(leagueId, userId, limit, before);
      res.status(200).json(messages);
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
}
