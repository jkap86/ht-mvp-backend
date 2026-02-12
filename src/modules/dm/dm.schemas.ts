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
  around_timestamp: z
    .string()
    .datetime({ message: 'Invalid ISO 8601 timestamp' })
    .optional(),
});

/** Schema for adding/removing a DM reaction */
export const dmReactionSchema = z.object({
  emoji: z
    .string()
    .min(1, 'Emoji is required')
    .max(8, 'Emoji too long'),
});

/** Schema for searching DM messages */
export const searchDmMessagesQuerySchema = z.object({
  q: z
    .string()
    .min(1, 'Search query is required')
    .max(100, 'Search query too long')
    .trim()
    .transform(stripHtml),
  limit: z
    .string()
    .regex(/^\d+$/, 'Limit must be a number')
    .transform(Number)
    .pipe(z.number().min(1).max(500))
    .optional()
    .default(100),
  offset: z
    .string()
    .regex(/^\d+$/, 'Offset must be a number')
    .transform(Number)
    .pipe(z.number().min(0))
    .optional()
    .default(0),
});

// Type exports from Zod schemas
export type SendDmInput = z.infer<typeof sendDmSchema>;
export type GetDmMessagesQueryInput = z.infer<typeof getDmMessagesQuerySchema>;
export type DmReactionInput = z.infer<typeof dmReactionSchema>;
export type SearchDmMessagesQueryInput = z.infer<typeof searchDmMessagesQuerySchema>;
