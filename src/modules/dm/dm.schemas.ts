import { z } from 'zod';

/**
 * Zod schemas for DM endpoint validation
 */

/** Strip HTML tags to prevent XSS in future web clients */
const stripHtml = (val: string) => val.replace(/<[^>]*>/g, '');

/** Schema for sending a DM message (supports gif:: prefix for GIF URLs) */
export const sendDmSchema = z.object({
  message: z
    .string()
    .min(1, 'Message cannot be empty')
    .max(1500, 'Message cannot exceed 1500 characters')
    .trim()
    .transform((val) => {
      // Don't strip HTML from gif:: prefixed URLs
      if (val.startsWith('gif::')) return val;
      return stripHtml(val);
    }),
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

/** Schema for adding/removing a DM reaction */
export const dmReactionSchema = z.object({
  emoji: z
    .string()
    .min(1, 'Emoji is required')
    .max(8, 'Emoji too long'),
});

// Type exports from Zod schemas
export type SendDmInput = z.infer<typeof sendDmSchema>;
export type GetDmMessagesQueryInput = z.infer<typeof getDmMessagesQuerySchema>;
export type DmReactionInput = z.infer<typeof dmReactionSchema>;
