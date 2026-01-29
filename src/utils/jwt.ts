import * as jwt from 'jsonwebtoken';
import { env } from '../config/env.config';

export interface JwtPayload {
  sub: string;
  userId: string;
  username: string;
}

export function signToken(payload: JwtPayload, options?: { expiresIn?: string }): string {
  const signOptions: jwt.SignOptions = {
    expiresIn: (options?.expiresIn || env.JWT_EXPIRES_IN) as jwt.SignOptions['expiresIn'],
  };

  return jwt.sign(payload, env.JWT_SECRET as jwt.Secret, signOptions);
}

export function verifyToken(token: string): JwtPayload {
  const decoded = jwt.verify(token, env.JWT_SECRET as jwt.Secret) as jwt.JwtPayload &
    Partial<JwtPayload>;

  const sub = (decoded.sub as string) ?? '';
  return {
    sub,
    userId: sub,
    username: (decoded as any).username ?? '',
  };
}
