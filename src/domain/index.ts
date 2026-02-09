/**
 * Domain Module - Command Bus and Commands
 *
 * This module provides the command bus infrastructure for centralized
 * domain mutation handling.
 *
 * Usage:
 * ```typescript
 * import { CommandBus, CommandTypes, createCommand } from './domain';
 *
 * // Dispatch a command
 * const result = await commandBus.dispatch(
 *   createCommand(
 *     CommandTypes.DRAFT_MAKE_PICK,
 *     { leagueId: 1, draftId: 1, playerId: 100 },
 *     { userId: 'user-123' }
 *   )
 * );
 * ```
 */

// Core command bus
export {
  CommandBus,
  CommandHandler,
  CommandResult,
  CommandMiddleware,
  LoggingMiddleware,
  IdempotencyMiddleware,
  IdempotencyError,
  getCommandBus,
  tryGetCommandBus,
  resetCommandBus,
} from './command-bus';

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

// Handler registration
export { registerAllHandlers } from './handlers';
