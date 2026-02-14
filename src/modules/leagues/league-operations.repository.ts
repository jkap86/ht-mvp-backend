import { Pool, PoolClient } from 'pg';
import { snakeToCamel } from '../../shared/mappers';

export interface LeagueOperation {
  id: number;
  idempotencyKey: string;
  leagueId: number | null;
  userId: string;
  operationType: string;
  responseData: any;
  createdAt: Date;
  expiresAt: Date;
}

function leagueOperationFromDatabase(row: any): LeagueOperation {
  return snakeToCamel<LeagueOperation>(row);
}

/**
 * Repository for league operation idempotency tracking.
 * Stores cached responses for retry-safe operations.
 */
export class LeagueOperationsRepository {
  constructor(private readonly pool: Pool) {}

  /**
   * Find an existing operation by idempotency key, user, and type.
   */
  async findByKey(
    leagueId: number | null,
    userId: string,
    idempotencyKey: string,
    client?: PoolClient
  ): Promise<LeagueOperation | null> {
    const db = client || this.pool;

    const result = await db.query(
      `SELECT id, idempotency_key, league_id, user_id, operation_type,
              response_data, created_at, expires_at
       FROM league_operations
       WHERE idempotency_key = $1 AND user_id = $2
         AND (league_id = $3 OR (league_id IS NULL AND $3 IS NULL))
         AND expires_at > NOW()
       LIMIT 1`,
      [idempotencyKey, userId, leagueId]
    );

    if (result.rows.length === 0) return null;

    return leagueOperationFromDatabase(result.rows[0]);
  }

  /**
   * Create a new operation record for idempotency tracking.
   */
  async create(
    leagueId: number | null,
    userId: string,
    operationType: string,
    idempotencyKey: string,
    responseData: any,
    client?: PoolClient
  ): Promise<LeagueOperation> {
    const db = client || this.pool;

    // Concurrency-safe: ON CONFLICT replaces check-then-insert race
    const result = await db.query(
      `INSERT INTO league_operations
       (idempotency_key, league_id, user_id, operation_type, response_data)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (idempotency_key, user_id, operation_type)
       DO NOTHING
       RETURNING id, idempotency_key, league_id, user_id, operation_type,
                 response_data, created_at, expires_at`,
      [idempotencyKey, leagueId, userId, operationType, JSON.stringify(responseData)]
    );

    if (result.rows.length > 0) {
      return leagueOperationFromDatabase(result.rows[0]);
    }

    // Conflict: re-select existing operation
    const existing = await this.findByKey(leagueId, userId, idempotencyKey, client);
    return existing!;
  }
}
