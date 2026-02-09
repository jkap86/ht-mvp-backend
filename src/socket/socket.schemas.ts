import { z } from 'zod';

/**
 * Socket payload schemas for validation.
 * Use with the onValidated helper in socket-validation.middleware.ts
 */

// ============ Base schemas ============

/**
 * Positive integer schema - used for IDs
 */
export const positiveIntSchema = z.number().int().positive();

/**
 * Optional string schema
 */
export const optionalStringSchema = z.string().optional();

// ============ Room join/leave schemas ============

/**
 * Join league room payload
 */
export const joinLeagueSchema = z.object({
  leagueId: positiveIntSchema,
});

/**
 * Leave league room payload
 */
export const leaveLeagueSchema = z.object({
  leagueId: positiveIntSchema,
});

/**
 * Join draft room payload
 */
export const joinDraftSchema = z.object({
  draftId: positiveIntSchema,
});

/**
 * Leave draft room payload
 */
export const leaveDraftSchema = z.object({
  draftId: positiveIntSchema,
});

// ============ Draft action schemas ============

/**
 * Make pick payload
 */
export const makePickSchema = z.object({
  draftId: positiveIntSchema,
  playerId: positiveIntSchema,
  leagueId: positiveIntSchema,
});

/**
 * Toggle autodraft payload
 */
export const toggleAutodraftSchema = z.object({
  draftId: positiveIntSchema,
  enabled: z.boolean(),
});

/**
 * Update queue payload
 */
export const updateQueueSchema = z.object({
  draftId: positiveIntSchema,
  playerIds: z.array(positiveIntSchema),
});

/**
 * Add to queue payload
 */
export const addToQueueSchema = z.object({
  draftId: positiveIntSchema,
  playerId: positiveIntSchema,
});

/**
 * Remove from queue payload
 */
export const removeFromQueueSchema = z.object({
  draftId: positiveIntSchema,
  playerId: positiveIntSchema,
});

// ============ Auction action schemas ============

/**
 * Place bid payload
 */
export const placeBidSchema = z.object({
  draftId: positiveIntSchema,
  lotId: positiveIntSchema,
  amount: z.number().int().nonnegative(),
});

/**
 * Set max bid payload
 */
export const setMaxBidSchema = z.object({
  draftId: positiveIntSchema,
  lotId: positiveIntSchema,
  maxBid: z.number().int().nonnegative(),
});

/**
 * Nominate player payload
 */
export const nominatePlayerSchema = z.object({
  draftId: positiveIntSchema,
  playerId: positiveIntSchema,
  initialBid: z.number().int().nonnegative().optional(),
});

// ============ Chat schemas ============

/**
 * Send chat message payload
 */
export const sendChatMessageSchema = z.object({
  leagueId: positiveIntSchema,
  content: z.string().min(1).max(2000),
});

/**
 * Send DM payload
 */
export const sendDmSchema = z.object({
  conversationId: positiveIntSchema,
  content: z.string().min(1).max(2000),
});

/**
 * Mark DM as read payload
 */
export const markDmReadSchema = z.object({
  conversationId: positiveIntSchema,
});

// ============ Trade schemas ============

/**
 * Trade proposal via socket
 */
export const tradeProposalSchema = z.object({
  leagueId: positiveIntSchema,
  partnerRosterId: positiveIntSchema,
  sendItems: z.array(
    z.object({
      playerId: positiveIntSchema.optional(),
      pickAssetId: positiveIntSchema.optional(),
    })
  ),
  receiveItems: z.array(
    z.object({
      playerId: positiveIntSchema.optional(),
      pickAssetId: positiveIntSchema.optional(),
    })
  ),
  message: z.string().max(500).optional(),
});

/**
 * Trade response (accept/reject/cancel)
 */
export const tradeResponseSchema = z.object({
  tradeId: positiveIntSchema,
  action: z.enum(['accept', 'reject', 'cancel']),
});

/**
 * Trade vote payload
 */
export const tradeVoteSchema = z.object({
  tradeId: positiveIntSchema,
  voteType: z.enum(['approve', 'veto']),
});

// ============ Waiver schemas ============

/**
 * Submit waiver claim payload
 */
export const submitWaiverClaimSchema = z.object({
  leagueId: positiveIntSchema,
  playerId: positiveIntSchema,
  dropPlayerId: positiveIntSchema.optional(),
  bidAmount: z.number().int().nonnegative().optional(),
});

/**
 * Cancel waiver claim payload
 */
export const cancelWaiverClaimSchema = z.object({
  claimId: positiveIntSchema,
});

/**
 * Update waiver claim payload
 */
export const updateWaiverClaimSchema = z.object({
  claimId: positiveIntSchema,
  bidAmount: z.number().int().nonnegative().optional(),
  dropPlayerId: positiveIntSchema.nullable().optional(),
});

/**
 * Reorder waiver claims payload
 */
export const reorderWaiverClaimsSchema = z.object({
  claimIds: z.array(positiveIntSchema),
});

// ============ Lineup schemas ============

/**
 * Set lineup payload
 */
export const setLineupSchema = z.object({
  leagueId: positiveIntSchema,
  rosterId: positiveIntSchema,
  week: positiveIntSchema,
  starters: z.array(z.union([positiveIntSchema, z.null()])),
});

/**
 * Swap lineup positions payload
 */
export const swapLineupSchema = z.object({
  leagueId: positiveIntSchema,
  rosterId: positiveIntSchema,
  week: positiveIntSchema,
  fromSlot: z.number().int().nonnegative(),
  toSlot: z.number().int().nonnegative(),
});

// ============ Derby schemas ============

/**
 * Pick derby slot payload
 */
export const pickDerbySlotSchema = z.object({
  draftId: positiveIntSchema,
  slotPosition: positiveIntSchema,
});

// ============ Schema map for lookup ============

/**
 * Map of event names to their schemas
 */
export const socketSchemas = {
  // Room management
  'join:league': joinLeagueSchema,
  'leave:league': leaveLeagueSchema,
  'join:draft': joinDraftSchema,
  'leave:draft': leaveDraftSchema,

  // Draft actions
  'draft:pick': makePickSchema,
  'draft:toggleAutodraft': toggleAutodraftSchema,
  'draft:updateQueue': updateQueueSchema,
  'draft:addToQueue': addToQueueSchema,
  'draft:removeFromQueue': removeFromQueueSchema,

  // Auction actions
  'auction:bid': placeBidSchema,
  'auction:maxBid': setMaxBidSchema,
  'auction:nominate': nominatePlayerSchema,

  // Chat actions
  'chat:send': sendChatMessageSchema,
  'dm:send': sendDmSchema,
  'dm:markRead': markDmReadSchema,

  // Trade actions
  'trade:propose': tradeProposalSchema,
  'trade:respond': tradeResponseSchema,
  'trade:vote': tradeVoteSchema,

  // Waiver actions
  'waiver:claim': submitWaiverClaimSchema,
  'waiver:cancel': cancelWaiverClaimSchema,
  'waiver:update': updateWaiverClaimSchema,
  'waiver:reorder': reorderWaiverClaimsSchema,

  // Lineup actions
  'lineup:set': setLineupSchema,
  'lineup:swap': swapLineupSchema,

  // Derby actions
  'derby:pickSlot': pickDerbySlotSchema,
} as const;

export type SocketEventName = keyof typeof socketSchemas;
