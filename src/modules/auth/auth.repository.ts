import { Pool } from 'pg';
import { User } from './auth.model';

export class UserRepository {
  constructor(private readonly db: Pool) {}

  async findByUsername(username: string): Promise<User | null> {
    const result = await this.db.query('SELECT * FROM users WHERE username = $1', [username]);

    if (result.rows.length === 0) {
      return null;
    }

    return User.fromDatabase(result.rows[0]);
  }

  async findById(userId: string): Promise<User | null> {
    const result = await this.db.query('SELECT * FROM users WHERE id = $1', [userId]);

    if (result.rows.length === 0) {
      return null;
    }

    return User.fromDatabase(result.rows[0]);
  }

  async create(username: string, email: string, passwordHash: string): Promise<User> {
    const result = await this.db.query(
      `INSERT INTO users (username, email, password_hash)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [username, email, passwordHash]
    );

    return User.fromDatabase(result.rows[0]);
  }

  async emailExists(email: string): Promise<boolean> {
    const result = await this.db.query('SELECT EXISTS(SELECT 1 FROM users WHERE email = $1)', [
      email,
    ]);

    return result.rows[0].exists;
  }

  async usernameExists(username: string): Promise<boolean> {
    const result = await this.db.query('SELECT EXISTS(SELECT 1 FROM users WHERE username = $1)', [
      username,
    ]);

    return result.rows[0].exists;
  }

  async searchByUsername(query: string, excludeUserId?: string): Promise<User[]> {
    let sqlQuery = `
      SELECT * FROM users
      WHERE LOWER(username) LIKE LOWER($1)
    `;
    const params: any[] = [`%${query}%`];

    if (excludeUserId) {
      sqlQuery += ` AND id != $2`;
      params.push(excludeUserId);
    }

    sqlQuery += ` ORDER BY username ASC LIMIT 20`;

    const result = await this.db.query(sqlQuery, params);

    return result.rows.map((row) => User.fromDatabase(row));
  }

  async updateRefreshToken(userId: string, token: string, expiresAt: Date): Promise<void> {
    await this.db.query(
      `UPDATE users
       SET refresh_token = $1, refresh_token_expires_at = $2, updated_at = NOW()
       WHERE id = $3`,
      [token, expiresAt, userId]
    );
  }

  async clearRefreshToken(userId: string): Promise<void> {
    await this.db.query(
      `UPDATE users
       SET refresh_token = NULL, refresh_token_expires_at = NULL, updated_at = NOW()
       WHERE id = $1`,
      [userId]
    );
  }

  async getRefreshToken(userId: string): Promise<string | null> {
    const result = await this.db.query('SELECT refresh_token FROM users WHERE id = $1', [userId]);

    if (result.rows.length === 0) {
      return null;
    }

    return result.rows[0].refresh_token;
  }

  async getRefreshTokenWithExpiry(
    userId: string
  ): Promise<{ token: string | null; expiresAt: Date | null }> {
    const result = await this.db.query(
      'SELECT refresh_token, refresh_token_expires_at FROM users WHERE id = $1',
      [userId]
    );

    if (result.rows.length === 0) {
      return { token: null, expiresAt: null };
    }

    return {
      token: result.rows[0].refresh_token,
      expiresAt: result.rows[0].refresh_token_expires_at,
    };
  }

  /**
   * Increment failed login attempts and return the new count
   */
  async incrementFailedAttempts(userId: string): Promise<number> {
    const result = await this.db.query(
      `UPDATE users
       SET failed_login_attempts = failed_login_attempts + 1, updated_at = NOW()
       WHERE id = $1
       RETURNING failed_login_attempts`,
      [userId]
    );

    return result.rows[0].failed_login_attempts;
  }

  /**
   * Lock account for specified duration (in minutes)
   */
  async lockAccount(userId: string, lockDurationMinutes: number): Promise<void> {
    await this.db.query(
      `UPDATE users
       SET locked_until = NOW() + make_interval(mins => $1), updated_at = NOW()
       WHERE id = $2`,
      [lockDurationMinutes, userId]
    );
  }

  /**
   * Reset failed login attempts (called on successful login)
   */
  async resetFailedAttempts(userId: string): Promise<void> {
    await this.db.query(
      `UPDATE users
       SET failed_login_attempts = 0, locked_until = NULL, updated_at = NOW()
       WHERE id = $1`,
      [userId]
    );
  }

  /**
   * Check if account is currently locked
   */
  async isAccountLocked(userId: string): Promise<boolean> {
    const result = await this.db.query(
      'SELECT locked_until FROM users WHERE id = $1',
      [userId]
    );

    if (result.rows.length === 0) {
      return false;
    }

    const lockedUntil = result.rows[0].locked_until;

    if (!lockedUntil) {
      return false;
    }

    // Check if locked_until is in the future
    return new Date(lockedUntil) > new Date();
  }
}
