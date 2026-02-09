import { z } from 'zod';

/**
 * Zod schemas for DM endpoint validation
 */

/** Schema for sending a DM message */
export const sendDmSchema = z.object({
  message: z
    .string()
    .min(1, 'Message cannot be empty')
    .max(1000, 'Message cannot exceed 1000 characters')
    .trim(),
});

/** Schema for DM message query parameters */
export const getDmMessagesQuerySchema = z.object({
  limit: z
    .string()
    .regex(/^\d+$/, 'Limit must be a number')
    .transform(Number)
    .pipe(z.number().min(1).max(100))
    .optional(),
  before: z
    .string()
    .regex(/^\d+$/, 'Before must be a number')
    .transform(Number)
    .pipe(z.number().positive())
    .optional(),
});

// Type exports from Zod schemas
export type SendDmInput = z.infer<typeof sendDmSchema>;
export type GetDmMessagesQueryInput = z.infer<typeof getDmMessagesQuerySchema>;
