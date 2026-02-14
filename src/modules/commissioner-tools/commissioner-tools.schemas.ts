import { z } from 'zod';

export const adjustChessClockSchema = z.object({
  delta_seconds: z.number().int().refine((v) => v !== 0, { message: 'delta_seconds must not be zero' }),
  reason: z.string().max(500).optional(),
});

export const forceAutopickSchema = z.object({}).strict().optional();

export const resetWaiverPrioritySchema = z.object({}).strict().optional();

export const setWaiverPrioritySchema = z.object({
  priority: z.number().int().min(1),
});

export const setFaabBudgetSchema = z.object({
  set_to: z.number().min(0),
});

export const adminCancelTradeSchema = z.object({
  reason: z.string().max(500).optional(),
});

export const updateCommissionerSettingsSchema = z.object({
  trading_locked: z.boolean(),
});
