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

// Safe string that rejects prototype pollution keys
const safeKey = z.string().refine((key) => !key.startsWith('__'), {
  message: 'Invalid key',
});

// Waiver type enum
const waiverTypeEnum = z.enum(['standard', 'faab', 'none']);

// Trade notification visibility enum
const tradeNotificationEnum = z.enum(['none', 'summary', 'details']);

// Strict settings schema (replaces z.record(z.string(), z.any()))
export const settingsSchema = z
  .object({
    commissioner_roster_id: z.number().int().optional(),
    waiver_type: waiverTypeEnum.optional(),
    waiver_day: z.number().int().min(0).max(6).optional(),
    waiver_hour: z.number().int().min(0).max(23).optional(),
    waiver_period_days: z.number().int().min(0).max(14).optional(),
    faab_budget: z.number().int().min(0).max(10000).optional(),
  })
  .passthrough()
  .refine(
    (obj) => Object.keys(obj).every((k) => !k.startsWith('__')),
    { message: 'Invalid settings key' }
  )
  .optional();

// Strict scoring settings schema
export const scoringSettingsSchema = z
  .object({
    type: z.enum(['ppr', 'half_ppr', 'standard']).optional(),
    rules: z
      .object({
        passTd: z.number().optional(),
        passYd: z.number().optional(),
        passInt: z.number().optional(),
        rushTd: z.number().optional(),
        rushYd: z.number().optional(),
        rec: z.number().optional(),
        recTd: z.number().optional(),
        recYd: z.number().optional(),
        fumLost: z.number().optional(),
        twoPt: z.number().optional(),
        bonusRushYd100: z.number().optional(),
        bonusRecYd100: z.number().optional(),
        bonusPassYd300: z.number().optional(),
        tePremium: z.number().optional(),
      })
      .passthrough()
      .optional(),
    // Flat format (snake_case from Flutter)
    pass_td: z.number().optional(),
    pass_yd: z.number().optional(),
    pass_int: z.number().optional(),
    rush_td: z.number().optional(),
    rush_yd: z.number().optional(),
    rec: z.number().optional(),
    rec_td: z.number().optional(),
    rec_yd: z.number().optional(),
    fum_lost: z.number().optional(),
    two_pt: z.number().optional(),
    bonus_rush_yd_100: z.number().optional(),
    bonus_rec_yd_100: z.number().optional(),
    bonus_pass_yd_300: z.number().optional(),
    te_premium: z.number().optional(),
  })
  .passthrough()
  .refine(
    (obj) => Object.keys(obj).every((k) => !k.startsWith('__')),
    { message: 'Invalid scoring settings key' }
  )
  .optional();

// League settings structure
export const leagueSettingsSchema = z
  .object({
    draftType: draftTypeEnum.optional(),
    auctionMode: auctionModeEnum.optional(),
    auctionBudget: z.number().int().min(1).max(10000).optional(),
    rosterSlots: z.number().int().min(5).max(30).optional(),
    rosterType: rosterTypeEnum.optional(),
    useLeagueMedian: z.boolean().optional(),
    tradeProposalLeagueChatMax: tradeNotificationEnum.optional(),
    tradeProposalLeagueChatDefault: tradeNotificationEnum.optional(),
    maxKeepers: z.number().int().min(0).max(30).optional(),
    keeperCostsEnabled: z.boolean().optional(),
    faabBudget: z.number().int().min(0).max(10000).optional(),
    allowMemberInvites: z.boolean().optional(),
  })
  .passthrough();

export const createLeagueSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100),
  season: z.string().regex(/^\d{4}$/, 'Season must be a 4-digit year'),
  total_rosters: z.number().min(2).max(20).optional().default(12),
  settings: settingsSchema,
  scoring_settings: scoringSettingsSchema,
  mode: leagueModeEnum.optional(),
  league_settings: leagueSettingsSchema.optional(),
  is_public: z.boolean().default(false).optional(),
  draft_structure: z.string().optional(), // 'combined', 'split', 'nfl_college', etc.
});

export const updateLeagueSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  status: z.string().optional(),
  settings: settingsSchema,
  scoring_settings: scoringSettingsSchema,
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
