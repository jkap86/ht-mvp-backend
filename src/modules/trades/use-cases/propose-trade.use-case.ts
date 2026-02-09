import { Pool, PoolClient } from 'pg';
import { TradesRepository, TradeItemsRepository } from '../trades.repository';
import { RosterPlayersRepository } from '../../rosters/rosters.repository';
import { LeagueRepository, RosterRepository } from '../../leagues/leagues.repository';
import { DraftPickAssetRepository } from '../../drafts/draft-pick-asset.repository';
import { PlayerRepository } from '../../players/players.repository';
import { EventTypes, tryGetEventBus } from '../../../shared/events';
import {
  TradeWithDetails,
  ProposeTradeRequest,
  tradeWithDetailsToResponse,
  TradeItemType,
} from '../trades.model';
import {
  NotFoundException,
  ForbiddenException,
  ValidationException,
  ConflictException,
} from '../../../utils/exceptions';
import { runWithLock, LockDomain } from '../../../shared/transaction-runner';
import { batchValidateRosterPlayers } from '../../../shared/batch-queries';
import { League } from '../../leagues/leagues.model';
import { Roster } from '../../leagues/leagues.model';
import {
  validatePickTrade,
  buildPickTradeItems,
  ValidatePickTradeContext,
} from './validate-pick-trade.use-case';
import { EventListenerService } from '../../chat/event-listener.service';
import { logger } from '../../../config/logger.config';
import { getEffectiveLeagueChatMode } from '../trade-notification.utils';
import { LeagueChatMode } from '../trades.model';

const DEFAULT_TRADE_EXPIRY_HOURS = 48;

export interface ProposeTradeContext {
  tradesRepo: TradesRepository;
  tradeItemsRepo: TradeItemsRepository;
  rosterRepo: RosterRepository;
  rosterPlayersRepo: RosterPlayersRepository;
  leagueRepo: LeagueRepository;
  playerRepo: PlayerRepository;
  pickAssetRepo?: DraftPickAssetRepository;
  eventListenerService?: EventListenerService;
}

export interface ProposeTradeContextWithPool extends ProposeTradeContext {
  db: Pool;
}

/**
 * Propose a new trade (standalone version - manages its own transaction)
 * Use this when proposing a trade as a standalone operation.
 */
export async function proposeTradeStandalone(
  ctx: ProposeTradeContextWithPool,
  leagueId: number,
  userId: string,
  request: ProposeTradeRequest
): Promise<TradeWithDetails> {
  // Pre-validate outside transaction (fail fast)
  const proposerRoster = await ctx.rosterRepo.findByLeagueAndUser(leagueId, userId);
  if (!proposerRoster) {
    throw new ForbiddenException('You are not a member of this league');
  }

  const recipientRoster = await ctx.rosterRepo.findByLeagueAndRosterId(
    leagueId,
    request.recipientRosterId
  );
  if (!recipientRoster) {
    throw new NotFoundException('Recipient roster not found in this league');
  }

  if (proposerRoster.id === recipientRoster.id) {
    throw new ValidationException('Cannot trade with yourself');
  }

  const league = await ctx.leagueRepo.findById(leagueId);
  if (!league) throw new NotFoundException('League not found');

  const tradeDeadline = league.settings?.trade_deadline;
  if (tradeDeadline && new Date(tradeDeadline) < new Date()) {
    throw new ValidationException('Trade deadline has passed');
  }

  const hasPlayers = request.offeringPlayerIds.length > 0 || request.requestingPlayerIds.length > 0;
  const hasPicks =
    (request.offeringPickAssetIds?.length ?? 0) > 0 ||
    (request.requestingPickAssetIds?.length ?? 0) > 0;
  if (!hasPlayers && !hasPicks) {
    throw new ValidationException('Trade must include at least one player or draft pick');
  }

  // Execute in transaction with lock
  const tradeWithDetails = await runWithLock(
    ctx.db,
    LockDomain.TRADE,
    leagueId,
    async (client) => {
      return await proposeTradeCore(ctx, client, leagueId, userId, request, proposerRoster, recipientRoster, league);
    }
  );

  // Emit domain event AFTER transaction commits
  const eventBus = tryGetEventBus();
  eventBus?.publish({
    type: EventTypes.TRADE_PROPOSED,
    leagueId,
    payload: tradeWithDetailsToResponse(tradeWithDetails),
  });

  // Emit system message to league chat and DM
  if (ctx.eventListenerService) {
    ctx.eventListenerService
      .handleTradeProposed(leagueId, tradeWithDetails.id, {
        notifyLeagueChat: tradeWithDetails.notifyLeagueChat,
        leagueChatMode: tradeWithDetails.leagueChatMode,
        notifyDm: tradeWithDetails.notifyDm,
      })
      .catch((err) => logger.warn('Failed to emit system message', {
        type: 'trade_proposed',
        leagueId,
        tradeId: tradeWithDetails.id,
        error: err.message
      }));
  }

  return tradeWithDetails;
}

/**
 * Propose a new trade (uses existing client/transaction)
 * Use this when proposing a trade as part of another transaction (e.g., counter trade).
 * The caller is responsible for transaction management.
 */
export async function proposeTrade(
  ctx: ProposeTradeContext,
  client: PoolClient,
  leagueId: number,
  userId: string,
  request: ProposeTradeRequest,
  manageTransaction: boolean
): Promise<TradeWithDetails> {
  // Note: manageTransaction is now ignored - always uses caller's transaction
  // Kept for backward compatibility with counter-trade.use-case.ts

  // Validate user owns a roster in this league
  const proposerRoster = await ctx.rosterRepo.findByLeagueAndUser(leagueId, userId);
  if (!proposerRoster) {
    throw new ForbiddenException('You are not a member of this league');
  }

  // Validate recipient roster exists
  const recipientRoster = await ctx.rosterRepo.findByLeagueAndRosterId(
    leagueId,
    request.recipientRosterId
  );
  if (!recipientRoster) {
    throw new NotFoundException('Recipient roster not found in this league');
  }

  if (proposerRoster.id === recipientRoster.id) {
    throw new ValidationException('Cannot trade with yourself');
  }

  // Get league settings
  const league = await ctx.leagueRepo.findById(leagueId);
  if (!league) throw new NotFoundException('League not found');

  // Check trade deadline
  const tradeDeadline = league.settings?.trade_deadline;
  if (tradeDeadline && new Date(tradeDeadline) < new Date()) {
    throw new ValidationException('Trade deadline has passed');
  }

  // Validate trade has at least one item (player or pick)
  const hasPlayers = request.offeringPlayerIds.length > 0 || request.requestingPlayerIds.length > 0;
  const hasPicks =
    (request.offeringPickAssetIds?.length ?? 0) > 0 ||
    (request.requestingPickAssetIds?.length ?? 0) > 0;
  if (!hasPlayers && !hasPicks) {
    throw new ValidationException('Trade must include at least one player or draft pick');
  }

  return await proposeTradeCore(ctx, client, leagueId, userId, request, proposerRoster, recipientRoster, league);
}

/**
 * Core trade creation logic - assumes caller has already validated and is within a transaction
 */
async function proposeTradeCore(
  ctx: ProposeTradeContext,
  client: PoolClient,
  leagueId: number,
  userId: string,
  request: ProposeTradeRequest,
  proposerRoster: Roster,
  recipientRoster: Roster,
  league: League
): Promise<TradeWithDetails> {
  // Validate offering players belong to proposer
  await validateOfferingPlayers(ctx, client, proposerRoster, request.offeringPlayerIds, leagueId);

  // Validate requested players belong to recipient
  await validateRequestingPlayers(
    ctx,
    client,
    recipientRoster.id,
    request.requestingPlayerIds,
    leagueId
  );

  // Validate draft picks if included
  const offeringPickAssetIds = request.offeringPickAssetIds || [];
  const requestingPickAssetIds = request.requestingPickAssetIds || [];
  let pickTradeItems: Array<{
    itemType: 'draft_pick';
    draftPickAssetId: number;
    pickSeason: number;
    pickRound: number;
    pickOriginalTeam: string;
    fromRosterId: number;
    toRosterId: number;
  }> = [];

  if (
    (offeringPickAssetIds.length > 0 || requestingPickAssetIds.length > 0) &&
    ctx.pickAssetRepo
  ) {
    const pickCtx: ValidatePickTradeContext = { pickAssetRepo: ctx.pickAssetRepo };
    const validatedPicks = await validatePickTrade(
      pickCtx,
      offeringPickAssetIds,
      requestingPickAssetIds,
      proposerRoster.id,
      recipientRoster.id,
      leagueId
    );
    pickTradeItems = buildPickTradeItems(validatedPicks);
  }

  // Calculate roster size changes and validate
  await validateRosterSizes(ctx, client, proposerRoster.id, recipientRoster.id, request, league);

  // Create trade
  const expiryHours = league.settings?.trade_expiry_hours || DEFAULT_TRADE_EXPIRY_HOURS;
  const expiresAt = new Date(Date.now() + expiryHours * 60 * 60 * 1000);

  // Compute effective league chat mode (clamp to commissioner settings)
  const commMax = (league.leagueSettings?.tradeProposalLeagueChatMax as LeagueChatMode) || 'details';
  const commDefault = (league.leagueSettings?.tradeProposalLeagueChatDefault as LeagueChatMode) || 'summary';
  const effectiveLeagueChatMode = getEffectiveLeagueChatMode(
    request.leagueChatMode,
    request.notifyLeagueChat,
    commMax,
    commDefault
  );
  const effectiveNotifyLeagueChat = effectiveLeagueChatMode !== 'none';

  const trade = await ctx.tradesRepo.create(
    leagueId,
    proposerRoster.id,
    recipientRoster.id,
    expiresAt,
    parseInt(league.season, 10),
    league.currentWeek || 1,
    request.message,
    undefined,
    client,
    effectiveNotifyLeagueChat,
    request.notifyDm,
    effectiveLeagueChatMode
  );

  // Create trade items for players
  const playerItems = await buildPlayerTradeItems(
    ctx.playerRepo,
    client,
    proposerRoster.id,
    recipientRoster.id,
    request.offeringPlayerIds,
    request.requestingPlayerIds
  );

  // Combine player and pick items
  const allItems: Array<{
    itemType: TradeItemType;
    playerId?: number;
    playerName?: string;
    playerPosition?: string;
    playerTeam?: string;
    draftPickAssetId?: number;
    pickSeason?: number;
    pickRound?: number;
    pickOriginalTeam?: string;
    fromRosterId: number;
    toRosterId: number;
  }> = [
    ...playerItems.map((item) => ({ ...item, itemType: 'player' as TradeItemType })),
    ...pickTradeItems,
  ];

  // Guard: trades must include at least one item
  if (allItems.length === 0) {
    throw new ValidationException('Trade must include at least one player or draft pick');
  }

  await ctx.tradeItemsRepo.createBulk(trade.id, allItems, client);

  // Get full trade details
  const tradeWithDetails = await ctx.tradesRepo.findByIdWithDetails(trade.id, proposerRoster.id);
  if (!tradeWithDetails) throw new Error('Failed to create trade');

  return tradeWithDetails;
}

async function validateOfferingPlayers(
  ctx: ProposeTradeContext,
  client: PoolClient,
  proposerRoster: Roster,
  playerIds: number[],
  leagueId: number
): Promise<void> {
  if (playerIds.length === 0) return;

  // Batch validate all players belong to proposer
  const validation = await batchValidateRosterPlayers(client, proposerRoster.id, playerIds);
  if (validation.missing.length > 0) {
    throw new ValidationException(`You do not own player ${validation.missing[0]}`);
  }

  // Batch check for players in pending trades
  const playersInPendingTrades = await ctx.tradesRepo.findPendingPlayerIds(leagueId, playerIds, client);
  if (playersInPendingTrades.size > 0) {
    const conflictingPlayerId = [...playersInPendingTrades][0];
    throw new ConflictException(`Player ${conflictingPlayerId} is already in a pending trade`);
  }
}

async function validateRequestingPlayers(
  ctx: ProposeTradeContext,
  client: PoolClient,
  recipientRosterId: number,
  playerIds: number[],
  leagueId: number
): Promise<void> {
  if (playerIds.length === 0) return;

  // Batch validate all players belong to recipient
  const validation = await batchValidateRosterPlayers(client, recipientRosterId, playerIds);
  if (validation.missing.length > 0) {
    throw new ValidationException(`Recipient does not own player ${validation.missing[0]}`);
  }

  // Batch check for players in pending trades
  const playersInPendingTrades = await ctx.tradesRepo.findPendingPlayerIds(leagueId, playerIds, client);
  if (playersInPendingTrades.size > 0) {
    const conflictingPlayerId = [...playersInPendingTrades][0];
    throw new ConflictException(`Player ${conflictingPlayerId} is already in a pending trade`);
  }
}

async function validateRosterSizes(
  ctx: ProposeTradeContext,
  client: PoolClient,
  proposerRosterId: number,
  recipientRosterId: number,
  request: ProposeTradeRequest,
  league: League
): Promise<void> {
  const netChangeProposer = request.requestingPlayerIds.length - request.offeringPlayerIds.length;
  const netChangeRecipient = request.offeringPlayerIds.length - request.requestingPlayerIds.length;
  const maxRosterSize = league.settings?.roster_size || 15;

  if (netChangeProposer > 0) {
    const proposerSize = await ctx.rosterPlayersRepo.getPlayerCount(proposerRosterId, client);
    if (proposerSize + netChangeProposer > maxRosterSize) {
      throw new ValidationException('Trade would exceed your roster size limit');
    }
  }

  if (netChangeRecipient > 0) {
    const recipientSize = await ctx.rosterPlayersRepo.getPlayerCount(recipientRosterId, client);
    if (recipientSize + netChangeRecipient > maxRosterSize) {
      throw new ValidationException('Trade would exceed recipient roster size limit');
    }
  }
}

async function buildPlayerTradeItems(
  playerRepo: PlayerRepository,
  client: PoolClient,
  proposerRosterId: number,
  recipientRosterId: number,
  offeringPlayerIds: number[],
  requestingPlayerIds: number[]
): Promise<
  Array<{
    playerId: number;
    fromRosterId: number;
    toRosterId: number;
    playerName: string;
    playerPosition?: string;
    playerTeam?: string;
  }>
> {
  const items: Array<{
    playerId: number;
    fromRosterId: number;
    toRosterId: number;
    playerName: string;
    playerPosition?: string;
    playerTeam?: string;
  }> = [];

  // Batch lookup all player details in a single query
  const allPlayerIds = [...offeringPlayerIds, ...requestingPlayerIds];
  if (allPlayerIds.length === 0) {
    return items;
  }

  const playerMap = await playerRepo.findByIdsWithDetails(allPlayerIds, client);

  // Players from proposer to recipient
  for (const playerId of offeringPlayerIds) {
    const playerInfo = playerMap.get(playerId);
    if (!playerInfo) {
      throw new ValidationException(`Player ${playerId} not found in database`);
    }
    items.push({
      playerId,
      fromRosterId: proposerRosterId,
      toRosterId: recipientRosterId,
      playerName: playerInfo.fullName,
      playerPosition: playerInfo.position ?? undefined,
      playerTeam: playerInfo.team ?? undefined,
    });
  }

  // Players from recipient to proposer
  for (const playerId of requestingPlayerIds) {
    const playerInfo = playerMap.get(playerId);
    if (!playerInfo) {
      throw new ValidationException(`Player ${playerId} not found in database`);
    }
    items.push({
      playerId,
      fromRosterId: recipientRosterId,
      toRosterId: proposerRosterId,
      playerName: playerInfo.fullName,
      playerPosition: playerInfo.position ?? undefined,
      playerTeam: playerInfo.team ?? undefined,
    });
  }

  return items;
}
