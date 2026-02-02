/**
 * User domain model
 */
export class User {
  constructor(
    public readonly userId: string,
    public readonly username: string,
    public readonly email: string,
    public readonly passwordHash: string,
    public readonly createdAt: Date,
    public readonly updatedAt: Date
  ) {}

  static fromDatabase(row: {
    id: string;
    username: string;
    email: string;
    password_hash: string;
    created_at: Date;
    updated_at: Date;
  }): User {
    return new User(
      row.id,
      row.username,
      row.email,
      row.password_hash,
      row.created_at,
      row.updated_at
    );
  }

  static isValidUsername(username: string): boolean {
    const usernameRegex = /^[a-zA-Z0-9_]{3,20}$/;
    return usernameRegex.test(username);
  }

  static readonly MIN_PASSWORD_LENGTH = 12;

  toSafeObject(): {
    userId: string;
    username: string;
    email: string;
    createdAt: Date;
    updatedAt: Date;
  } {
    return {
      userId: this.userId,
      username: this.username,
      email: this.email,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }
}
