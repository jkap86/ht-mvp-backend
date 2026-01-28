import { z } from 'zod';

/**
 * Zod schemas for trade endpoint validation
 */

/** Schema for proposing a new trade */
export const proposeTradeSchema = z.object({
  recipient_roster_id: z.number().int().positive('Recipient roster ID must be a positive integer'),
  offering_player_ids: z
    .array(z.number().int().positive('Each offering player ID must be a positive integer'))
    .default([]),
  requesting_player_ids: z
    .array(z.number().int().positive('Each requesting player ID must be a positive integer'))
    .default([]),
  offering_pick_asset_ids: z
    .array(z.number().int().positive('Each offering pick asset ID must be a positive integer'))
    .default([]),
  requesting_pick_asset_ids: z
    .array(z.number().int().positive('Each requesting pick asset ID must be a positive integer'))
    .default([]),
  message: z.string().max(500, 'Message cannot exceed 500 characters').optional(),
}).refine(
  (data) =>
    data.requesting_player_ids.length > 0 ||
    data.requesting_pick_asset_ids.length > 0,
  { message: 'Must request at least one player or draft pick' }
);

/** Schema for countering a trade */
export const counterTradeSchema = z.object({
  offering_player_ids: z
    .array(z.number().int().positive('Each offering player ID must be a positive integer'))
    .default([]),
  requesting_player_ids: z
    .array(z.number().int().positive('Each requesting player ID must be a positive integer'))
    .default([]),
  offering_pick_asset_ids: z
    .array(z.number().int().positive('Each offering pick asset ID must be a positive integer'))
    .default([]),
  requesting_pick_asset_ids: z
    .array(z.number().int().positive('Each requesting pick asset ID must be a positive integer'))
    .default([]),
  message: z.string().max(500, 'Message cannot exceed 500 characters').optional(),
}).refine(
  (data) =>
    data.requesting_player_ids.length > 0 ||
    data.requesting_pick_asset_ids.length > 0,
  { message: 'Must request at least one player or draft pick' }
);

/** Schema for voting on a trade */
export const voteTradeSchema = z.object({
  vote: z.enum(['approve', 'veto'], {
    message: 'Vote must be "approve" or "veto"',
  }),
});

// Type exports from Zod schemas
export type ProposeTradeInput = z.infer<typeof proposeTradeSchema>;
export type CounterTradeInput = z.infer<typeof counterTradeSchema>;
export type VoteTradeInput = z.infer<typeof voteTradeSchema>;
