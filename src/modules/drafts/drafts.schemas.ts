import { z } from 'zod';

export const createDraftSchema = z.object({
  draft_type: z.enum(['snake', 'linear'], {
    message: 'Draft type must be "snake" or "linear"',
  }),
  rounds: z.number().int().min(1, 'Rounds must be at least 1').max(30, 'Rounds cannot exceed 30'),
  pick_time_seconds: z
    .number()
    .int()
    .min(30, 'Pick time must be at least 30 seconds')
    .max(600, 'Pick time cannot exceed 600 seconds'),
});

export const makePickSchema = z.object({
  player_id: z.number().int().positive('Player ID must be a positive integer'),
});

export const addToQueueSchema = z.object({
  player_id: z.number().int().positive('Player ID must be a positive integer'),
});

export const reorderQueueSchema = z.object({
  player_ids: z
    .array(z.number().int().positive('Each player ID must be a positive integer'))
    .min(1, 'Player IDs array cannot be empty'),
});

export type CreateDraftInput = z.infer<typeof createDraftSchema>;
export type MakePickInput = z.infer<typeof makePickSchema>;
export type AddToQueueInput = z.infer<typeof addToQueueSchema>;
export type ReorderQueueInput = z.infer<typeof reorderQueueSchema>;
