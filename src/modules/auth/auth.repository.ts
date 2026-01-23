import { Pool } from 'pg';
import { User } from './auth.model';

export class UserRepository {
  constructor(private readonly db: Pool) {}

  async findByUsername(username: string): Promise<User | null> {
    const result = await this.db.query(
      'SELECT * FROM users WHERE username = $1',
      [username]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return User.fromDatabase(result.rows[0]);
  }

  async findById(userId: string): Promise<User | null> {
    const result = await this.db.query(
      'SELECT * FROM users WHERE id = $1',
      [userId]
    );

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
    const result = await this.db.query(
      'SELECT EXISTS(SELECT 1 FROM users WHERE email = $1)',
      [email]
    );

    return result.rows[0].exists;
  }

  async usernameExists(username: string): Promise<boolean> {
    const result = await this.db.query(
      'SELECT EXISTS(SELECT 1 FROM users WHERE username = $1)',
      [username]
    );

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
}
