import { z } from 'zod';

/** Schema for registering a device token */
export const registerDeviceSchema = z.object({
  token: z.string().min(1, 'Token is required').max(500),
  device_type: z.enum(['ios', 'android', 'web'], {
    message: 'device_type must be "ios", "android", or "web"',
  }),
  device_name: z.string().max(200).optional(),
});

/** Schema for unregistering a device token */
export const unregisterDeviceSchema = z.object({
  token: z.string().min(1, 'Token is required').max(500),
});

/** Schema for updating notification preferences (strict — rejects unknown fields) */
export const updatePreferencesSchema = z
  .object({
    enabledPush: z.boolean().optional(),
    draftStart: z.boolean().optional(),
    draftYourTurn: z.boolean().optional(),
    draftCompleted: z.boolean().optional(),
    tradeOffers: z.boolean().optional(),
    tradeAccepted: z.boolean().optional(),
    tradeCountered: z.boolean().optional(),
    tradeVoted: z.boolean().optional(),
    tradeCompleted: z.boolean().optional(),
    waiverResults: z.boolean().optional(),
    waiverProcessing: z.boolean().optional(),
    waiverEndingSoon: z.boolean().optional(),
    lineupLocks: z.boolean().optional(),
    playerNews: z.boolean().optional(),
    breakingNews: z.boolean().optional(),
  })
  .strict();

// Type exports
export type RegisterDeviceInput = z.infer<typeof registerDeviceSchema>;
export type UnregisterDeviceInput = z.infer<typeof unregisterDeviceSchema>;
export type UpdatePreferencesInput = z.infer<typeof updatePreferencesSchema>;
