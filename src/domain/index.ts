/**
 * Domain Module - Pure Domain Types and Commands
 *
 * This module exports pure domain types and command definitions.
 * Command bus infrastructure has moved to src/shared/command-bus/.
 *
 * Usage:
 * ```typescript
 * import { CommandTypes, createCommand } from './domain';
 *
 * // Create a command
 * const command = createCommand(
 *   CommandTypes.DRAFT_MAKE_PICK,
 *   { leagueId: 1, draftId: 1, playerId: 100 },
 *   { userId: 'user-123' }
 * );
 * ```
 */

// Commands and types
export {
  Command,
  CommandActor,
  CommandMetadata,
  CommandTypes,
  CommandType,
  createCommand,
  // Draft payloads
  DraftMakePickPayload,
  DraftMakePickAssetPayload,
  DraftAutoPickPayload,
  DraftTimeoutPayload,
  DraftStartPayload,
  DraftPausePayload,
  DraftResumePayload,
  DraftCompletePayload,
  DraftUndoPickPayload,
  // Auction payloads
  AuctionPlaceBidPayload,
  AuctionSetMaxBidPayload,
  AuctionNominatePayload,
  // Trade payloads
  TradeProposePayload,
  TradeAcceptPayload,
  TradeRejectPayload,
  TradeCancelPayload,
  TradeCounterPayload,
  TradeVotePayload,
  TradeItemPayload,
  // Waiver payloads
  WaiverSubmitClaimPayload,
  WaiverCancelClaimPayload,
  WaiverReorderClaimsPayload,
  WaiverProcessLeaguePayload,
  // Roster payloads
  RosterAddPlayerPayload,
  RosterDropPlayerPayload,
  RosterAddDropPayload,
  // Lineup payloads
  LineupSetPayload,
  LineupSwapPayload,
  // Playoff payloads
  PlayoffGenerateBracketPayload,
  PlayoffAdvanceWinnersPayload,
  PlayoffFinalizePayload,
} from './commands';
