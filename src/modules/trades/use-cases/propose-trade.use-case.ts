import { PoolClient } from 'pg';
import { TradesRepository, TradeItemsRepository } from '../trades.repository';
import { RosterPlayersRepository } from '../../rosters/rosters.repository';
import { LeagueRepository, RosterRepository } from '../../leagues/leagues.repository';
import { tryGetSocketService } from '../../../socket';
import {
  TradeWithDetails,
  ProposeTradeRequest,
  tradeWithDetailsToResponse,
} from '../trades.model';
import {
  NotFoundException,
  ForbiddenException,
  ValidationException,
  ConflictException,
} from '../../../utils/exceptions';
import { getTradeLockId } from '../../../utils/locks';
import { League } from '../../leagues/leagues.model';
import { Roster } from '../../leagues/leagues.model';

const DEFAULT_TRADE_EXPIRY_HOURS = 48;

export interface ProposeTradeContext {
  tradesRepo: TradesRepository;
  tradeItemsRepo: TradeItemsRepository;
  rosterRepo: RosterRepository;
  rosterPlayersRepo: RosterPlayersRepository;
  leagueRepo: LeagueRepository;
}

/**
 * Propose a new trade
 * @param existingClient - Optional: If provided, uses this client and skips transaction management (for counter trades)
 */
export async function proposeTrade(
  ctx: ProposeTradeContext,
  client: PoolClient,
  leagueId: number,
  userId: string,
  request: ProposeTradeRequest,
  manageTransaction: boolean
): Promise<TradeWithDetails> {
  // Validate user owns a roster in this league
  const proposerRoster = await ctx.rosterRepo.findByLeagueAndUser(leagueId, userId);
  if (!proposerRoster) {
    throw new ForbiddenException('You are not a member of this league');
  }

  // Validate recipient roster exists
  const recipientRoster = await ctx.rosterRepo.findById(request.recipientRosterId);
  if (!recipientRoster || recipientRoster.leagueId !== leagueId) {
    throw new NotFoundException('Recipient roster not found in this league');
  }

  if (proposerRoster.id === request.recipientRosterId) {
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

  // Validate players
  if (request.offeringPlayerIds.length === 0 && request.requestingPlayerIds.length === 0) {
    throw new ValidationException('Trade must include at least one player');
  }

  if (manageTransaction) {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [getTradeLockId(leagueId)]);
  }

  try {
    // Validate offering players belong to proposer
    await validateOfferingPlayers(ctx, client, proposerRoster, request.offeringPlayerIds, leagueId);

    // Validate requested players belong to recipient
    await validateRequestingPlayers(ctx, client, request.recipientRosterId, request.requestingPlayerIds, leagueId);

    // Calculate roster size changes and validate
    await validateRosterSizes(ctx, client, proposerRoster.id, request.recipientRosterId, request, league);

    // Create trade
    const expiryHours = league.settings?.trade_expiry_hours || DEFAULT_TRADE_EXPIRY_HOURS;
    const expiresAt = new Date(Date.now() + expiryHours * 60 * 60 * 1000);

    const trade = await ctx.tradesRepo.create(
      leagueId,
      proposerRoster.id,
      request.recipientRosterId,
      expiresAt,
      parseInt(league.season, 10),
      league.currentWeek || 1,
      request.message,
      undefined,
      client
    );

    // Create trade items
    const items = await buildTradeItems(
      client,
      proposerRoster.id,
      request.recipientRosterId,
      request.offeringPlayerIds,
      request.requestingPlayerIds
    );

    await ctx.tradeItemsRepo.createBulk(trade.id, items, client);

    if (manageTransaction) {
      await client.query('COMMIT');
    }

    // Get full trade details
    const tradeWithDetails = await ctx.tradesRepo.findByIdWithDetails(trade.id, proposerRoster.id);
    if (!tradeWithDetails) throw new Error('Failed to create trade');

    // Emit socket event (only for standalone trades, counter emits its own event)
    if (manageTransaction) {
      emitTradeProposed(leagueId, tradeWithDetails);
    }

    return tradeWithDetails;
  } catch (error) {
    if (manageTransaction) {
      await client.query('ROLLBACK');
    }
    throw error;
  }
}

async function validateOfferingPlayers(
  ctx: ProposeTradeContext,
  client: PoolClient,
  proposerRoster: Roster,
  playerIds: number[],
  leagueId: number
): Promise<void> {
  for (const playerId of playerIds) {
    const playerRoster = await ctx.rosterPlayersRepo.findByRosterAndPlayer(
      proposerRoster.id,
      playerId,
      client
    );
    if (!playerRoster) {
      throw new ValidationException(`You do not own player ${playerId}`);
    }

    // Check player not in another pending trade
    const pendingTrades = await ctx.tradesRepo.findPendingByPlayer(leagueId, playerId);
    if (pendingTrades.length > 0) {
      throw new ConflictException(`Player ${playerId} is already in a pending trade`);
    }
  }
}

async function validateRequestingPlayers(
  ctx: ProposeTradeContext,
  client: PoolClient,
  recipientRosterId: number,
  playerIds: number[],
  leagueId: number
): Promise<void> {
  for (const playerId of playerIds) {
    const playerRoster = await ctx.rosterPlayersRepo.findByRosterAndPlayer(
      recipientRosterId,
      playerId,
      client
    );
    if (!playerRoster) {
      throw new ValidationException(`Recipient does not own player ${playerId}`);
    }

    // Check player not in another pending trade
    const pendingTrades = await ctx.tradesRepo.findPendingByPlayer(leagueId, playerId);
    if (pendingTrades.length > 0) {
      throw new ConflictException(`Player ${playerId} is already in a pending trade`);
    }
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

async function buildTradeItems(
  client: PoolClient,
  proposerRosterId: number,
  recipientRosterId: number,
  offeringPlayerIds: number[],
  requestingPlayerIds: number[]
): Promise<Array<{
  playerId: number;
  fromRosterId: number;
  toRosterId: number;
  playerName: string;
  playerPosition?: string;
  playerTeam?: string;
}>> {
  const items: Array<{
    playerId: number;
    fromRosterId: number;
    toRosterId: number;
    playerName: string;
    playerPosition?: string;
    playerTeam?: string;
  }> = [];

  // Players from proposer to recipient
  for (const playerId of offeringPlayerIds) {
    const playerInfo = await client.query(
      'SELECT full_name, position, team FROM players WHERE id = $1',
      [playerId]
    );
    if (playerInfo.rows.length > 0) {
      items.push({
        playerId,
        fromRosterId: proposerRosterId,
        toRosterId: recipientRosterId,
        playerName: playerInfo.rows[0].full_name,
        playerPosition: playerInfo.rows[0].position,
        playerTeam: playerInfo.rows[0].team,
      });
    }
  }

  // Players from recipient to proposer
  for (const playerId of requestingPlayerIds) {
    const playerInfo = await client.query(
      'SELECT full_name, position, team FROM players WHERE id = $1',
      [playerId]
    );
    if (playerInfo.rows.length > 0) {
      items.push({
        playerId,
        fromRosterId: recipientRosterId,
        toRosterId: proposerRosterId,
        playerName: playerInfo.rows[0].full_name,
        playerPosition: playerInfo.rows[0].position,
        playerTeam: playerInfo.rows[0].team,
      });
    }
  }

  return items;
}

function emitTradeProposed(leagueId: number, trade: TradeWithDetails): void {
  const socket = tryGetSocketService();
  socket?.emitTradeProposed(leagueId, tradeWithDetailsToResponse(trade));
}
