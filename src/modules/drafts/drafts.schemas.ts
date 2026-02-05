import { z } from 'zod';

/** Zod schema for draft type validation */
export const draftTypeSchema = z.enum(['snake', 'linear', 'auction'], {
  message: 'Draft type must be "snake", "linear", or "auction"',
});

/** Zod schema for auction mode validation */
export const auctionModeSchema = z.enum(['slow', 'fast']).default('slow');

/** Zod schema for player pool in draft settings */
export const playerPoolSchema = z.array(
  z.enum(['veteran', 'rookie', 'college'])
).min(1, 'At least one player pool type must be selected').default(['veteran', 'rookie']);

/** Zod schema for auction settings */
export const auctionSettingsSchema = z.object({
  auction_mode: auctionModeSchema,
  // Slow auction settings
  bid_window_seconds: z.number().int().min(3600).max(172800).default(43200),
  max_active_nominations_per_team: z.number().int().min(1).max(10).default(2),
  max_active_nominations_global: z.number().int().min(1).max(100).default(25),
  daily_nomination_limit: z.number().int().min(1).max(10).nullable().default(null),
  // Fast auction settings
  nomination_seconds: z.number().int().min(15).max(120).default(45),
  reset_on_bid_seconds: z.number().int().min(5).max(30).default(10),
  // Shared settings
  min_bid: z.number().int().min(1).default(1),
  min_increment: z.number().int().min(1).default(1),
});

export const createDraftSchema = z.object({
  draft_type: draftTypeSchema.default('snake'),
  rounds: z
    .number()
    .int()
    .min(1, 'Rounds must be at least 1')
    .max(30, 'Rounds cannot exceed 30')
    .default(15),
  pick_time_seconds: z
    .number()
    .int()
    .min(30, 'Pick time must be at least 30 seconds')
    .max(600, 'Pick time cannot exceed 600 seconds')
    .default(90),
  auction_settings: auctionSettingsSchema.optional(),
  player_pool: playerPoolSchema.optional(),
  /** For vet-only drafts: include rookie draft picks as draftable items */
  include_rookie_picks: z.boolean().optional(),
  /** The season for which rookie draft picks should be included */
  rookie_picks_season: z.number().int().min(2020).max(2100).optional(),
});

/** Schema for updating draft settings (commissioner only) */
export const updateDraftSettingsSchema = z.object({
  draft_type: draftTypeSchema.optional(),
  rounds: z
    .number()
    .int()
    .min(1, 'Rounds must be at least 1')
    .max(30, 'Rounds cannot exceed 30')
    .optional(),
  pick_time_seconds: z
    .number()
    .int()
    .min(30, 'Pick time must be at least 30 seconds')
    .max(600, 'Pick time cannot exceed 600 seconds')
    .optional(),
  auction_settings: auctionSettingsSchema.partial().optional(),
  player_pool: playerPoolSchema.optional(),
  scheduled_start: z.string().datetime().nullable().optional(),
  /** For vet-only drafts: include rookie draft picks as draftable items */
  include_rookie_picks: z.boolean().optional(),
  /** The season for which rookie draft picks should be included */
  rookie_picks_season: z.number().int().min(2020).max(2100).optional(),
});

export const makePickSchema = z.object({
  player_id: z.number().int().positive('Player ID must be a positive integer'),
});

export const addToQueueSchema = z.object({
  player_id: z.number().int().positive('Player ID must be a positive integer').optional(),
  pick_asset_id: z.number().int().positive('Pick asset ID must be a positive integer').optional(),
}).refine(
  (data) => (data.player_id !== undefined) !== (data.pick_asset_id !== undefined),
  { message: 'Must provide either player_id or pick_asset_id, but not both' }
);

export const reorderQueueSchema = z.object({
  player_ids: z
    .array(z.number().int().positive('Each player ID must be a positive integer'))
    .optional(),
  queue_entry_ids: z
    .array(z.number().int().positive('Each entry ID must be a positive integer'))
    .optional(),
}).refine(
  (data) => Array.isArray(data.player_ids) || Array.isArray(data.queue_entry_ids),
  { message: 'Must provide either player_ids or queue_entry_ids' }
);

// Unified action schema supporting state changes, picks, and queue operations
export const draftActionSchema = z.discriminatedUnion('action', [
  // State actions (commissioner only)
  z.object({ action: z.literal('start') }),
  z.object({ action: z.literal('pause') }),
  z.object({ action: z.literal('resume') }),
  z.object({ action: z.literal('complete') }),

  // Pick action - either a player OR a pick asset (for vet drafts with rookie picks)
  z.object({
    action: z.literal('pick'),
    playerId: z.number().int().positive('Player ID must be a positive integer').optional(),
    draftPickAssetId: z.number().int().positive('Draft pick asset ID must be a positive integer').optional(),
  }).refine(
    (data) => (data.playerId !== undefined) !== (data.draftPickAssetId !== undefined),
    { message: 'Must provide either playerId or draftPickAssetId, but not both' }
  ),

  // Queue actions
  z.object({
    action: z.literal('queue_add'),
    playerId: z.number().int().positive('Player ID must be a positive integer'),
  }),
  z.object({
    action: z.literal('queue_remove'),
    playerId: z.number().int().positive('Player ID must be a positive integer'),
  }),
  z.object({
    action: z.literal('queue_reorder'),
    playerIds: z
      .array(z.number().int().positive('Each player ID must be a positive integer'))
      .min(1),
  }),

  // Auction actions
  z.object({
    action: z.literal('nominate'),
    playerId: z.number().int().positive('Player ID must be a positive integer'),
  }),
  z.object({
    action: z.literal('set_max_bid'),
    lotId: z.number().int().positive('Lot ID must be a positive integer'),
    maxBid: z.number().int().min(1, 'Max bid must be at least 1'),
  }),
]);

// Type exports from Zod schemas
export type DraftTypeSchema = z.infer<typeof draftTypeSchema>;
export type AuctionModeSchema = z.infer<typeof auctionModeSchema>;
export type PlayerPoolSchema = z.infer<typeof playerPoolSchema>;
export type AuctionSettingsInput = z.infer<typeof auctionSettingsSchema>;
export type CreateDraftInput = z.infer<typeof createDraftSchema>;
export type UpdateDraftSettingsInput = z.infer<typeof updateDraftSettingsSchema>;
export type MakePickInput = z.infer<typeof makePickSchema>;
export type AddToQueueInput = z.infer<typeof addToQueueSchema>;
export type ReorderQueueInput = z.infer<typeof reorderQueueSchema>;
export type DraftActionInput = z.infer<typeof draftActionSchema>;

/** Validation constraints for draft configuration */
export const DRAFT_CONFIG_CONSTRAINTS = {
  rounds: { min: 1, max: 30 },
  pickTimeSeconds: { min: 30, max: 600 },
  bidWindowSeconds: { min: 3600, max: 172800 },
  maxActiveNominationsPerTeam: { min: 1, max: 10 },
  maxActiveNominationsGlobal: { min: 1, max: 100 },
  dailyNominationLimit: { min: 1, max: 10 },
  budget: { min: 1, max: 10000 },
  // Fast auction constraints
  nominationSeconds: { min: 15, max: 120 },
  resetOnBidSeconds: { min: 5, max: 30 },
} as const;
