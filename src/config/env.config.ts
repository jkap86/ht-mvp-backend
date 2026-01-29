import { z } from 'zod';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Define the schema for environment variables (simplified for MVP)
const envSchema = z.object({
  // Database
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  // JWT
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_EXPIRES_IN: z.string().default('7d'),

  // Server
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z
    .string()
    .default('5000')
    .transform((val) => parseInt(val, 10)),

  // Frontend (for CORS) - used by both Express and Socket.IO
  FRONTEND_URL: z.string().url().optional(),

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
      throw new Error('Invalid environment configuration');
    }
    throw error;
  }
};

// Export validated environment variables
export const env = parseEnv();

// Type for environment variables
export type Env = z.infer<typeof envSchema>;

// Log levels in order of verbosity
const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

// Simple logger that respects LOG_LEVEL
export const logger = {
  debug: (message: string, ...args: any[]) => {
    if (LOG_LEVELS.indexOf(env.LOG_LEVEL) <= LOG_LEVELS.indexOf('debug')) {
      console.log(`[DEBUG] ${message}`, ...args);
    }
  },
  info: (message: string, ...args: any[]) => {
    if (LOG_LEVELS.indexOf(env.LOG_LEVEL) <= LOG_LEVELS.indexOf('info')) {
      console.log(`[INFO] ${message}`, ...args);
    }
  },
  warn: (message: string, ...args: any[]) => {
    if (LOG_LEVELS.indexOf(env.LOG_LEVEL) <= LOG_LEVELS.indexOf('warn')) {
      console.warn(`[WARN] ${message}`, ...args);
    }
  },
  error: (message: string, ...args: any[]) => {
    console.error(`[ERROR] ${message}`, ...args);
  },
};
