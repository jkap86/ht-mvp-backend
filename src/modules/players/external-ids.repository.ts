import { Pool, PoolClient } from 'pg';

export interface ExternalIdMapping {
  playerId: number;
  provider: string;
  externalId: string;
}

/**
 * Repository for managing player external ID mappings
 *
 * This repository provides database access for the player_external_ids table,
 * which maps provider-specific player IDs to our internal canonical player IDs.
 *
 * Key operations:
 * - Lookup player by provider + external ID
 * - Get bulk external ID → player ID mappings for stats syncing
 * - Upsert external ID mappings during player syncs
 */
export class ExternalIdRepository {
  constructor(private readonly db: Pool) {}

  /**
   * Get external ID map for a provider
   * Returns a map of external_id -> player_id for efficient bulk lookups during stats sync
   *
   * @param provider - Provider identifier (e.g., 'sleeper', 'fantasypros')
   * @returns Map of external_id -> player_id
   */
  async getExternalIdMap(provider: string): Promise<Map<string, number>> {
    const result = await this.db.query(
      'SELECT external_id, player_id FROM player_external_ids WHERE provider = $1',
      [provider]
    );

    const map = new Map<string, number>();
    for (const row of result.rows) {
      map.set(row.external_id, row.player_id);
    }
    return map;
  }

  /**
   * Get external ID map for a provider (transaction-safe version)
   *
   * @param client - Database client (for use within transactions)
   * @param provider - Provider identifier
   * @returns Map of external_id -> player_id
   */
  async getExternalIdMapWithClient(
    client: PoolClient,
    provider: string
  ): Promise<Map<string, number>> {
    const result = await client.query(
      'SELECT external_id, player_id FROM player_external_ids WHERE provider = $1',
      [provider]
    );

    const map = new Map<string, number>();
    for (const row of result.rows) {
      map.set(row.external_id, row.player_id);
    }
    return map;
  }

  /**
   * Find player ID by provider and external ID
   *
   * @param provider - Provider identifier
   * @param externalId - Provider-specific player ID
   * @returns Internal player ID or null if not found
   */
  async findPlayerByExternalId(provider: string, externalId: string): Promise<number | null> {
    const result = await this.db.query(
      'SELECT player_id FROM player_external_ids WHERE provider = $1 AND external_id = $2',
      [provider, externalId]
    );
    return result.rows[0]?.player_id || null;
  }

  /**
   * Find player ID by provider and external ID (transaction-safe version)
   *
   * @param client - Database client (for use within transactions)
   * @param provider - Provider identifier
   * @param externalId - Provider-specific player ID
   * @returns Internal player ID or null if not found
   */
  async findPlayerByExternalIdWithClient(
    client: PoolClient,
    provider: string,
    externalId: string
  ): Promise<number | null> {
    const result = await client.query(
      'SELECT player_id FROM player_external_ids WHERE provider = $1 AND external_id = $2',
      [provider, externalId]
    );
    return result.rows[0]?.player_id || null;
  }

  /**
   * Upsert external ID mapping
   * Creates or updates the mapping between a player and a provider-specific external ID
   *
   * @param playerId - Internal player ID
   * @param provider - Provider identifier
   * @param externalId - Provider-specific player ID
   * @param client - Optional database client (for use within transactions)
   */
  async upsertExternalId(
    playerId: number,
    provider: string,
    externalId: string,
    client?: PoolClient
  ): Promise<void> {
    const db = client || this.db;
    await db.query(
      `INSERT INTO player_external_ids (player_id, provider, external_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (player_id, provider)
       DO UPDATE SET external_id = EXCLUDED.external_id, updated_at = CURRENT_TIMESTAMP`,
      [playerId, provider, externalId]
    );
  }

  /**
   * Batch upsert external ID mappings
   * Efficiently inserts/updates multiple external ID mappings in a single query
   *
   * @param mappings - Array of mappings to upsert
   * @param client - Optional database client (for use within transactions)
   */
  async batchUpsertExternalIds(
    mappings: ExternalIdMapping[],
    client?: PoolClient
  ): Promise<void> {
    if (mappings.length === 0) {
      return;
    }

    const db = client || this.db;
    const values: any[] = [];
    const placeholders = mappings
      .map((mapping, idx) => {
        const baseIdx = idx * 3;
        values.push(mapping.playerId, mapping.provider, mapping.externalId);
        return `($${baseIdx + 1}, $${baseIdx + 2}, $${baseIdx + 3})`;
      })
      .join(', ');

    await db.query(
      `INSERT INTO player_external_ids (player_id, provider, external_id)
       VALUES ${placeholders}
       ON CONFLICT (player_id, provider)
       DO UPDATE SET external_id = EXCLUDED.external_id, updated_at = CURRENT_TIMESTAMP`,
      values
    );
  }

  /**
   * Get all external IDs for a player
   * Useful for debugging or displaying player info with all provider mappings
   *
   * @param playerId - Internal player ID
   * @returns Array of external ID mappings for this player
   */
  async getExternalIdsForPlayer(playerId: number): Promise<ExternalIdMapping[]> {
    const result = await this.db.query(
      'SELECT player_id, provider, external_id FROM player_external_ids WHERE player_id = $1',
      [playerId]
    );
    return result.rows.map((row) => ({
      playerId: row.player_id,
      provider: row.provider,
      externalId: row.external_id,
    }));
  }

  /**
   * Delete all external IDs for a provider
   * Useful for cleanup or provider removal
   *
   * @param provider - Provider identifier
   * @returns Number of mappings deleted
   */
  async deleteAllForProvider(provider: string): Promise<number> {
    const result = await this.db.query(
      'DELETE FROM player_external_ids WHERE provider = $1',
      [provider]
    );
    return result.rowCount || 0;
  }
}
