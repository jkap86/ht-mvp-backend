import { z } from 'zod';

/**
 * Zod schemas for chat endpoint validation
 */

/** Strip HTML tags to prevent XSS in future web clients */
const stripHtml = (val: string) => val.replace(/<[^>]*>/g, '');

/** Schema for sending a chat message (supports gif:: prefix for GIF URLs) */
export const sendMessageSchema = z.object({
  message: z
    .string()
    .min(1, 'Message cannot be empty')
    .max(1500, 'Message cannot exceed 1500 characters')
    .trim()
    .transform((val) => {
      // Validate gif:: prefixed URLs
      if (val.startsWith('gif::')) {
        const url = val.substring(5);
        try { new URL(url); } catch { throw new Error('Invalid GIF URL'); }
        if (!url.startsWith('https://')) throw new Error('GIF URL must use HTTPS');
        return val;
      }
      return stripHtml(val);
    }),
});

/** Schema for chat message query parameters */
export const getMessagesQuerySchema = z.object({
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

/** Schema for adding/removing a reaction */
export const reactionSchema = z.object({
  emoji: z
    .string()
    .min(1, 'Emoji is required')
    .max(8, 'Emoji too long'),
});

// Type exports from Zod schemas
export type SendMessageInput = z.infer<typeof sendMessageSchema>;
export type GetMessagesQueryInput = z.infer<typeof getMessagesQuerySchema>;
export type ReactionInput = z.infer<typeof reactionSchema>;
