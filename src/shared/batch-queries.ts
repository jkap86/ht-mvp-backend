import { Pool, PoolClient } from 'pg';

/**
 * Result from a batch validation query.
 */
export interface BatchValidationResult<T> {
  /** Map of found items keyed by their ID */
  found: Map<number, T>;
  /** IDs that were not found or failed validation */
  missing: number[];
}

/**
 * Batch validate that players exist on a roster.
 *
 * Replaces N individual findByRosterAndPlayer calls with a single query.
 * This significantly reduces transaction time and lock holding.
 *
 * @param client - Database client (within transaction)
 * @param rosterId - The roster to check
 * @param playerIds - Player IDs to validate
 * @returns Found players and missing player IDs
 */
export async function batchValidateRosterPlayers(
  client: PoolClient | Pool,
  rosterId: number,
  playerIds: number[]
): Promise<BatchValidationResult<{ playerId: number }>> {
  if (playerIds.length === 0) {
    return { found: new Map(), missing: [] };
  }

  const result = await client.query(
    `SELECT player_id FROM roster_players
     WHERE roster_id = $1 AND player_id = ANY($2)`,
    [rosterId, playerIds]
  );

  const found = new Map<number, { playerId: number }>(
    result.rows.map((r) => [r.player_id, { playerId: r.player_id }])
  );
  const missing = playerIds.filter((id) => !found.has(id));

  return { found, missing };
}

/**
 * Batch validate pick asset ownership.
 *
 * Checks that all pick assets exist and are owned by the expected roster.
 *
 * @param client - Database client (within transaction)
 * @param expectedOwnerId - The roster ID that should own these assets
 * @param pickAssetIds - Pick asset IDs to validate
 * @returns Found assets and missing/wrong-owner asset IDs
 */
export async function batchValidatePickAssets(
  client: PoolClient | Pool,
  expectedOwnerId: number,
  pickAssetIds: number[]
): Promise<BatchValidationResult<{ id: number; currentOwnerId: number }>> {
  if (pickAssetIds.length === 0) {
    return { found: new Map(), missing: [] };
  }

  const result = await client.query(
    `SELECT id, current_owner_roster_id
     FROM draft_pick_assets
     WHERE id = ANY($1)`,
    [pickAssetIds]
  );

  const found = new Map<number, { id: number; currentOwnerId: number }>();
  const missing: number[] = [];

  const rowMap = new Map(result.rows.map((r) => [r.id, r]));

  for (const id of pickAssetIds) {
    const row = rowMap.get(id);
    if (!row) {
      missing.push(id);
    } else if (row.current_owner_roster_id !== expectedOwnerId) {
      // Asset exists but wrong owner
      missing.push(id);
    } else {
      found.set(id, { id: row.id, currentOwnerId: row.current_owner_roster_id });
    }
  }

  return { found, missing };
}

/**
 * Batch fetch roster IDs by player IDs.
 *
 * Useful for finding which roster owns each player in a trade.
 *
 * @param client - Database client
 * @param playerIds - Player IDs to look up
 * @returns Map of player ID to roster ID
 */
export async function batchGetRostersByPlayers(
  client: PoolClient | Pool,
  playerIds: number[]
): Promise<Map<number, number>> {
  if (playerIds.length === 0) {
    return new Map();
  }

  const result = await client.query(
    `SELECT player_id, roster_id FROM roster_players
     WHERE player_id = ANY($1)`,
    [playerIds]
  );

  return new Map(result.rows.map((r) => [r.player_id, r.roster_id]));
}

/**
 * Batch check if players are on any roster in a league.
 *
 * Useful for waiver/free agent validation.
 *
 * @param client - Database client
 * @param leagueId - League to check
 * @param playerIds - Player IDs to check
 * @returns Set of player IDs that are rostered
 */
export async function batchCheckRosteredPlayers(
  client: PoolClient | Pool,
  leagueId: number,
  playerIds: number[]
): Promise<Set<number>> {
  if (playerIds.length === 0) {
    return new Set();
  }

  const result = await client.query(
    `SELECT DISTINCT rp.player_id
     FROM roster_players rp
     JOIN league_rosters lr ON lr.id = rp.roster_id
     WHERE lr.league_id = $1 AND rp.player_id = ANY($2)`,
    [leagueId, playerIds]
  );

  return new Set(result.rows.map((r) => r.player_id));
}

/**
 * Batch validate trade assets (both players and picks) for a trade.
 *
 * Combines player and pick validation into one call.
 *
 * @param client - Database client
 * @param rosterId - Roster that should own the assets
 * @param playerIds - Player IDs in the trade
 * @param pickAssetIds - Pick asset IDs in the trade
 * @returns Validation result with found assets and any missing
 */
export async function batchValidateTradeAssets(
  client: PoolClient | Pool,
  rosterId: number,
  playerIds: number[],
  pickAssetIds: number[]
): Promise<{
  players: BatchValidationResult<{ playerId: number }>;
  picks: BatchValidationResult<{ id: number; currentOwnerId: number }>;
  valid: boolean;
}> {
  // Run both validations in parallel (they're independent)
  const [players, picks] = await Promise.all([
    batchValidateRosterPlayers(client, rosterId, playerIds),
    batchValidatePickAssets(client, rosterId, pickAssetIds),
  ]);

  const valid = players.missing.length === 0 && picks.missing.length === 0;

  return { players, picks, valid };
}
