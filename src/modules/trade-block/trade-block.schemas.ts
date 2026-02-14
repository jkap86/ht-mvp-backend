import { z } from 'zod';

export const addToTradeBlockSchema = z.object({
  player_id: z.number().int().positive('Player ID must be a positive integer'),
  note: z.string().max(200, 'Note cannot exceed 200 characters').optional(),
});

export type AddToTradeBlockInput = z.infer<typeof addToTradeBlockSchema>;
