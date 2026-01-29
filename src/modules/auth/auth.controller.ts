import { Request, Response, NextFunction } from 'express';
import { AuthService } from './auth.service';
import { AuthRequest } from '../../middleware/auth.middleware';
import { InvalidCredentialsException, ValidationException } from '../../utils/exceptions';

export class AuthController {
  constructor(private readonly authService: AuthService) {}

  private mapUserToResponse(user: {
    userId: string;
    username: string;
    email: string;
    createdAt?: Date;
    updatedAt?: Date;
  }) {
    return {
      id: user.userId,
      username: user.username,
      email: user.email,
      created_at: user.createdAt,
      updated_at: user.updatedAt,
    };
  }

  register = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { username, email, password } = req.body;

      const result = await this.authService.register(username, email, password);

      res.status(201).json({
        user: this.mapUserToResponse(result.user),
        token: result.token,
        refreshToken: result.refreshToken,
      });
    } catch (error) {
      next(error);
    }
  };

  login = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { username, password } = req.body;

      const result = await this.authService.login(username, password);

      res.status(200).json({
        user: this.mapUserToResponse(result.user),
        token: result.token,
        refreshToken: result.refreshToken,
      });
    } catch (error) {
      next(error);
    }
  };

  me = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const userId = req.user?.userId;
      if (!userId) {
        return next(new InvalidCredentialsException('User ID not found'));
      }

      const user = await this.authService.getCurrentUser(userId);

      res.status(200).json({
        user: this.mapUserToResponse(user),
      });
    } catch (error) {
      next(error);
    }
  };

  refresh = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { refreshToken } = req.body;

      if (!refreshToken) {
        return next(new ValidationException('Refresh token is required'));
      }

      const result = await this.authService.refreshAccessToken(refreshToken);

      res.status(200).json({
        user: this.mapUserToResponse(result.user),
        token: result.token,
        refreshToken: result.refreshToken,
      });
    } catch (error) {
      next(error);
    }
  };

  searchUsers = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const userId = req.user?.userId;
      if (!userId) {
        return next(new InvalidCredentialsException('User ID not found'));
      }

      const query = req.query.q as string;
      if (!query || query.trim().length === 0) {
        res.status(200).json([]);
        return;
      }

      const users = await this.authService.searchUsers(query.trim(), userId);

      res.status(200).json(users.map((user) => this.mapUserToResponse(user)));
    } catch (error) {
      next(error);
    }
  };

  logout = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const userId = req.user?.userId;
      if (!userId) {
        return next(new InvalidCredentialsException('User ID not found'));
      }

      await this.authService.logout(userId);

      res.status(200).json({ message: 'Logged out successfully' });
    } catch (error) {
      next(error);
    }
  };
}
