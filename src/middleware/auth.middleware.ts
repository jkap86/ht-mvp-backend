import { Request, Response, NextFunction } from 'express';
import { verifyToken } from '../utils/jwt';

export interface AuthRequest extends Request {
  user?: {
    userId: string;
    username: string;
  };
}

export const authMiddleware = (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  const header = req.headers.authorization;

  if (!header || !header.startsWith('Bearer ')) {
    return res
      .status(401)
      .json({ error: 'Missing or invalid Authorization header', status: 401 });
  }

  const token = header.replace('Bearer ', '');

  try {
    const payload = verifyToken(token);

    req.user = {
      userId: payload.sub,
      username: payload.username,
    };

    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token', status: 401 });
  }
};
