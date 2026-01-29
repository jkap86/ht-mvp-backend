import { z } from 'zod';

// Submit a waiver claim
export const submitClaimSchema = z.object({
  body: z.object({
    player_id: z.number().int().positive('Player ID is required'),
    drop_player_id: z.number().int().positive().optional().nullable(),
    bid_amount: z.number().int().min(0, 'Bid amount cannot be negative').default(0),
  }),
  params: z.object({
    leagueId: z.string().regex(/^\d+$/).transform(Number),
  }),
});

// Update a waiver claim
export const updateClaimSchema = z.object({
  body: z.object({
    drop_player_id: z.number().int().positive().optional().nullable(),
    bid_amount: z.number().int().min(0, 'Bid amount cannot be negative').optional(),
  }),
  params: z.object({
    leagueId: z.string().regex(/^\d+$/).transform(Number),
    claimId: z.string().regex(/^\d+$/).transform(Number),
  }),
});

// Cancel a waiver claim
export const cancelClaimSchema = z.object({
  params: z.object({
    leagueId: z.string().regex(/^\d+$/).transform(Number),
    claimId: z.string().regex(/^\d+$/).transform(Number),
  }),
});

// Get claims (with optional filters)
export const getClaimsSchema = z.object({
  params: z.object({
    leagueId: z.string().regex(/^\d+$/).transform(Number),
  }),
  query: z
    .object({
      status: z.enum(['pending', 'successful', 'failed', 'cancelled', 'invalid']).optional(),
      roster_id: z.string().regex(/^\d+$/).transform(Number).optional(),
      week: z.string().regex(/^\d+$/).transform(Number).optional(),
      limit: z.string().regex(/^\d+$/).transform(Number).optional().default(50),
      offset: z.string().regex(/^\d+$/).transform(Number).optional().default(0),
    })
    .optional(),
});

// Get waiver priority
export const getPrioritySchema = z.object({
  params: z.object({
    leagueId: z.string().regex(/^\d+$/).transform(Number),
  }),
});

// Get FAAB budgets
export const getFaabBudgetsSchema = z.object({
  params: z.object({
    leagueId: z.string().regex(/^\d+$/).transform(Number),
  }),
});

// Get waiver wire players
export const getWaiverWireSchema = z.object({
  params: z.object({
    leagueId: z.string().regex(/^\d+$/).transform(Number),
  }),
});

// Initialize waivers (commissioner only)
export const initializeWaiversSchema = z.object({
  params: z.object({
    leagueId: z.string().regex(/^\d+$/).transform(Number),
  }),
  body: z
    .object({
      faab_budget: z.number().int().min(0).max(10000).optional(),
    })
    .default({}),
});

// Process claims (admin/job only)
export const processClaimsSchema = z.object({
  params: z.object({
    leagueId: z.string().regex(/^\d+$/).transform(Number),
  }),
});

export type SubmitClaimInput = z.infer<typeof submitClaimSchema>;
export type UpdateClaimInput = z.infer<typeof updateClaimSchema>;
export type CancelClaimInput = z.infer<typeof cancelClaimSchema>;
export type GetClaimsInput = z.infer<typeof getClaimsSchema>;
export type GetPriorityInput = z.infer<typeof getPrioritySchema>;
export type GetFaabBudgetsInput = z.infer<typeof getFaabBudgetsSchema>;
export type GetWaiverWireInput = z.infer<typeof getWaiverWireSchema>;
export type InitializeWaiversInput = z.infer<typeof initializeWaiversSchema>;
export type ProcessClaimsInput = z.infer<typeof processClaimsSchema>;
