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

// Unified action schema supporting state changes, picks, and queue operations
export const draftActionSchema = z.discriminatedUnion('action', [
  // State actions (commissioner only)
  z.object({ action: z.literal('start') }),
  z.object({ action: z.literal('pause') }),
  z.object({ action: z.literal('resume') }),
  z.object({ action: z.literal('complete') }),

  // Pick action
  z.object({
    action: z.literal('pick'),
    playerId: z.number().int().positive('Player ID must be a positive integer'),
  }),

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
    playerIds: z.array(z.number().int().positive('Each player ID must be a positive integer')).min(1),
  }),
]);

export type CreateDraftInput = z.infer<typeof createDraftSchema>;
export type MakePickInput = z.infer<typeof makePickSchema>;
export type AddToQueueInput = z.infer<typeof addToQueueSchema>;
export type ReorderQueueInput = z.infer<typeof reorderQueueSchema>;
export type DraftActionInput = z.infer<typeof draftActionSchema>;
