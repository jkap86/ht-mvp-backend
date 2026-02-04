import { z } from 'zod';

/**
 * Schema for payout structure - maps place strings to percentages
 */
export const payoutStructureSchema = z.record(z.string(), z.number().min(0).max(100)).refine(
  (data) => {
    const total = Object.values(data).reduce((sum, val) => sum + val, 0);
    return total <= 100;
  },
  { message: 'Payout percentages cannot exceed 100%' }
);

/**
 * Schema for creating/updating dues configuration
 */
export const upsertDuesConfigSchema = z.object({
  buy_in_amount: z.number().min(0).max(10000),
  payout_structure: payoutStructureSchema.optional().default({}),
  currency: z.string().min(1).max(10).optional().default('USD'),
  notes: z.string().max(500).nullable().optional(),
});

/**
 * Schema for marking payment status
 */
export const markPaymentSchema = z.object({
  is_paid: z.boolean(),
  notes: z.string().max(500).nullable().optional(),
});

export type UpsertDuesConfigInput = z.infer<typeof upsertDuesConfigSchema>;
export type MarkPaymentInput = z.infer<typeof markPaymentSchema>;
