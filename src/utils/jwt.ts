import * as jwt from 'jsonwebtoken';
import { env } from '../config/env.config';

export interface JwtPayload {
  sub: string;
  userId: string;
  username: string;
  type?: 'access' | 'refresh';
}

export function signToken(payload: JwtPayload, options?: { expiresIn?: string }): string {
  const signOptions: jwt.SignOptions = {
    algorithm: 'HS256',
    expiresIn: (options?.expiresIn || env.JWT_EXPIRES_IN) as jwt.SignOptions['expiresIn'],
  };

  return jwt.sign(payload, env.JWT_SECRET as jwt.Secret, signOptions);
}

export function verifyToken(token: string): JwtPayload {
  const decoded = jwt.verify(token, env.JWT_SECRET as jwt.Secret, {
    algorithms: ['HS256'],
  }) as jwt.JwtPayload & Partial<JwtPayload>;

  const sub = (decoded.sub as string) ?? '';
  return {
    sub,
    userId: sub,
    username: (decoded as any).username ?? '',
    type: (decoded as any).type as 'access' | 'refresh' | undefined,
  };
}
