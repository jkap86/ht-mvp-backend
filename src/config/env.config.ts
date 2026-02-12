import { z } from 'zod';
import dotenv from 'dotenv';
import { ValidationException } from '../utils/exceptions';

// Load environment variables
dotenv.config();

// Define the schema for environment variables (simplified for MVP)
const envSchema = z.object({
  // Database
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  // JWT
  JWT_SECRET: z.string().min(64, 'JWT_SECRET must be at least 64 characters'),
  JWT_EXPIRES_IN: z.string().default('7d'),

  // Server
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z
    .string()
    .default('5000')
    .transform((val) => parseInt(val, 10)),

  // Frontend (for CORS) - used by both Express and Socket.IO
  // Required in production, optional in development
  FRONTEND_URL:
    process.env.NODE_ENV === 'production'
      ? z.string().url().min(1, 'FRONTEND_URL is required in production')
      : z.string().url().optional(),

  // Additional frontend URLs (comma-separated) for multi-origin CORS support
  FRONTEND_URLS: z.string().optional(),

  // Background Jobs
  // Set to "true" to enable background jobs (autopick, player sync)
  // In multi-instance deployments, only one instance should run jobs
  RUN_JOBS: z
    .string()
    .default('true')
    .transform((val) => val === 'true'),

  // Logging
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  // Redis
  REDIS_HOST: z.string().optional(),
  REDIS_PORT: z.string().optional(),
  REDIS_PASSWORD: z.string().optional(),
  REDIS_DB: z.string().optional(),

  // Database Connection Pool
  DB_POOL_SIZE: z
    .string()
    .optional()
    .transform((val) => (val ? parseInt(val, 10) : 20)),
});

// Parse and validate environment variables
const parseEnv = () => {
  try {
    return envSchema.parse(process.env);
  } catch (error) {
    if (error instanceof z.ZodError) {
      console.error('❌ Environment validation failed:');
      error.issues.forEach((issue) => {
        console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
      });
      throw new ValidationException('Invalid environment configuration');
    }
    throw error;
  }
};

// Export validated environment variables
export const env = parseEnv();

// Type for environment variables
export type Env = z.infer<typeof envSchema>;

