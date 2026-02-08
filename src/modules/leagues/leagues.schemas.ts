import { z } from 'zod';

// Enums
export const leagueModeEnum = z.enum(['redraft', 'dynasty', 'keeper', 'devy']);
export const draftTypeEnum = z.enum([
  'snake',
  'linear',
  'third_round_reversal',
  'auction',
  'derby',
]);
export const auctionModeEnum = z.enum(['live', 'slow']);

// Roster type enum
export const rosterTypeEnum = z.enum(['lineup', 'bestball']);

// League settings structure
export const leagueSettingsSchema = z
  .object({
    draftType: draftTypeEnum.optional(),
    auctionMode: auctionModeEnum.optional(),
    auctionBudget: z.number().int().min(1).max(10000).optional(),
    rosterSlots: z.number().int().min(5).max(30).optional(),
    rosterType: rosterTypeEnum.optional(),
  })
  .passthrough();

export const createLeagueSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100),
  season: z.string().regex(/^\d{4}$/, 'Season must be a 4-digit year'),
  total_rosters: z.number().min(2).max(20).optional().default(12),
  settings: z.record(z.string(), z.any()).optional(),
  scoring_settings: z.record(z.string(), z.any()).optional(),
  mode: leagueModeEnum.optional(),
  league_settings: leagueSettingsSchema.optional(),
  is_public: z.boolean().default(false).optional(),
  draft_structure: z.string().optional(), // 'combined', 'split', 'nfl_college', etc.
});

export const updateLeagueSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  status: z.string().optional(),
  settings: z.record(z.string(), z.any()).optional(),
  scoring_settings: z.record(z.string(), z.any()).optional(),
  mode: leagueModeEnum.optional(),
  league_settings: leagueSettingsSchema.optional(),
  is_public: z.boolean().optional(),
  total_rosters: z.number().min(2).max(20).optional(),
});

// Delete league schema - requires typed confirmation
export const deleteLeagueSchema = z.object({
  confirmationName: z.string().min(1, 'Confirmation name is required'),
});

// Season status enum
export const seasonStatusEnum = z.enum(['pre_season', 'regular_season', 'playoffs', 'offseason']);

// Season controls schema - for manual season status/week updates
export const seasonControlsSchema = z
  .object({
    seasonStatus: seasonStatusEnum.optional(),
    currentWeek: z.number().int().min(1).max(18).optional(),
  })
  .refine((data) => data.seasonStatus !== undefined || data.currentWeek !== undefined, {
    message: 'At least one of seasonStatus or currentWeek must be provided',
  });

export type CreateLeagueInput = z.infer<typeof createLeagueSchema>;
export type UpdateLeagueInput = z.infer<typeof updateLeagueSchema>;
export type DeleteLeagueInput = z.infer<typeof deleteLeagueSchema>;
export type SeasonControlsInput = z.infer<typeof seasonControlsSchema>;
