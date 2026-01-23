import { z } from 'zod';

export const createLeagueSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100),
  season: z.string().regex(/^\d{4}$/, 'Season must be a 4-digit year').optional(),
  total_rosters: z.number().min(2).max(20).optional().default(12),
  settings: z.record(z.string(), z.any()).optional(),
  scoring_settings: z.record(z.string(), z.any()).optional(),
});

export const updateLeagueSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  status: z.string().optional(),
  settings: z.record(z.string(), z.any()).optional(),
  scoring_settings: z.record(z.string(), z.any()).optional(),
});

export type CreateLeagueInput = z.infer<typeof createLeagueSchema>;
export type UpdateLeagueInput = z.infer<typeof updateLeagueSchema>;
