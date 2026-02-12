import * as jwt from 'jsonwebtoken';
import { z } from 'zod';
import { env } from '../config/env.config';

export interface JwtPayload {
  sub: string;
  userId: string;
  username: string;
  type?: 'access' | 'refresh';
}

// Zod schema for runtime validation of JWT payloads
const JwtPayloadSchema = z.object({
  sub: z.string(),
  userId: z.string().optional(), // May not be present in all tokens
  username: z.string(),
  type: z.enum(['access', 'refresh']).optional(),
  iat: z.number().optional(), // Standard JWT fields
  exp: z.number().optional(),
  iss: z.string().optional(),
  aud: z.string().optional(),
});

export function signToken(payload: JwtPayload, options: { expiresIn: string }): string {
  const signOptions: jwt.SignOptions = {
    algorithm: 'HS256',
    expiresIn: options.expiresIn as jwt.SignOptions['expiresIn'],
  };

  return jwt.sign(payload, env.JWT_SECRET as jwt.Secret, signOptions);
}

export function verifyToken(token: string): JwtPayload {
  // Verify JWT signature and expiration
  const decoded = jwt.verify(token, env.JWT_SECRET as jwt.Secret, {
    algorithms: ['HS256'],
  });

  // Runtime validation with zod to ensure payload shape matches expectations
  const parsed = JwtPayloadSchema.parse(decoded);

  // Return type-safe payload
  return {
    sub: parsed.sub,
    userId: parsed.userId ?? parsed.sub, // Fall back to sub if userId not present
    username: parsed.username,
    type: parsed.type,
  };
}
