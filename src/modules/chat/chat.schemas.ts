import { z } from 'zod';

/**
 * Zod schemas for chat endpoint validation
 */

/** Strip HTML tags to prevent XSS in future web clients */
const stripHtml = (val: string) => val.replace(/<[^>]*>/g, '');

/** Schema for sending a chat message */
export const sendMessageSchema = z.object({
  message: z
    .string()
    .min(1, 'Message cannot be empty')
    .max(1000, 'Message cannot exceed 1000 characters')
    .trim()
    .transform(stripHtml),
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

// Type exports from Zod schemas
export type SendMessageInput = z.infer<typeof sendMessageSchema>;
export type GetMessagesQueryInput = z.infer<typeof getMessagesQuerySchema>;
