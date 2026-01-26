import { z } from 'zod';

// Enums
export const leagueModeEnum = z.enum(['redraft', 'dynasty', 'keeper']);
export const draftTypeEnum = z.enum(['snake', 'linear', 'third_round_reversal', 'auction', 'derby']);
export const auctionModeEnum = z.enum(['live', 'slow']);

// League settings structure
export const leagueSettingsSchema = z.object({
  draftType: draftTypeEnum.optional(),
  auctionMode: auctionModeEnum.optional(),
  auctionBudget: z.number().int().min(1).max(10000).optional(),
  rosterSlots: z.number().int().min(5).max(30).optional(),
}).passthrough();

export const createLeagueSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100),
  season: z.string().regex(/^\d{4}$/, 'Season must be a 4-digit year').optional(),
  total_rosters: z.number().min(2).max(20).optional().default(12),
  settings: z.record(z.string(), z.any()).optional(),
  scoring_settings: z.record(z.string(), z.any()).optional(),
  mode: leagueModeEnum.optional(),
  league_settings: leagueSettingsSchema.optional(),
  is_public: z.boolean().default(false).optional(),
});

export const updateLeagueSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  status: z.string().optional(),
  settings: z.record(z.string(), z.any()).optional(),
  scoring_settings: z.record(z.string(), z.any()).optional(),
  mode: leagueModeEnum.optional(),
  league_settings: leagueSettingsSchema.optional(),
  is_public: z.boolean().optional(),
});

export type CreateLeagueInput = z.infer<typeof createLeagueSchema>;
export type UpdateLeagueInput = z.infer<typeof updateLeagueSchema>;
