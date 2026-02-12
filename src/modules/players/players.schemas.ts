import { z } from 'zod';

// ========== Main player list/search query ==========
export const playerQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  q: z.string().max(200).optional(),
  position: z.string().max(10).optional(),
  team: z.string().max(10).optional(),
  playerType: z.enum(['nfl', 'college']).optional(),
  playerPool: z.string().max(50).optional(), // comma-separated: "veteran,rookie,college"
});

export type PlayerQueryInput = z.infer<typeof playerQuerySchema>;

// ========== Player search query ==========
export const playerSearchSchema = z.object({
  q: z.string().max(200).optional(),
  position: z.string().max(10).optional(),
  team: z.string().max(10).optional(),
  playerType: z.enum(['nfl', 'college']).optional(),
});

export type PlayerSearchInput = z.infer<typeof playerSearchSchema>;

// ========== College player sync query ==========
export const syncCollegeSchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100).optional(),
});

export type SyncCollegeInput = z.infer<typeof syncCollegeSchema>;

// ========== Player news query ==========
export const playerNewsSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(10),
});

export type PlayerNewsInput = z.infer<typeof playerNewsSchema>;

// ========== Latest news query ==========
export const latestNewsSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export type LatestNewsInput = z.infer<typeof latestNewsSchema>;

// ========== Breaking news query ==========
export const breakingNewsSchema = z.object({
  hours: z.coerce.number().int().min(1).max(168).default(24), // max 1 week
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type BreakingNewsInput = z.infer<typeof breakingNewsSchema>;

// ========== Player game logs query ==========
export const gameLogsSchema = z.object({
  season: z
    .string()
    .regex(/^\d{4}$/, 'Season must be a 4-digit year')
    .default('2024'),
  limit: z.coerce.number().int().min(1).max(100).default(10),
});

export type GameLogsInput = z.infer<typeof gameLogsSchema>;

// ========== Player projection query ==========
export const projectionSchema = z.object({
  season: z
    .string()
    .regex(/^\d{4}$/, 'Season must be a 4-digit year')
    .default('2024'),
  week: z.coerce.number().int().min(1).max(18),
});

export type ProjectionInput = z.infer<typeof projectionSchema>;

// ========== Player trends query ==========
export const trendsSchema = z.object({
  season: z
    .string()
    .regex(/^\d{4}$/, 'Season must be a 4-digit year')
    .default('2024'),
  weeks: z.coerce.number().int().min(1).max(18).default(8),
});

export type TrendsInput = z.infer<typeof trendsSchema>;
