import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { User } from './auth.model';
import { UserRepository } from './auth.repository';
import {
  ValidationException,
  InvalidCredentialsException,
  ConflictException,
} from '../../utils/exceptions';
import { signToken, verifyToken } from '../../utils/jwt';

/**
 * Hash a token using SHA-256 for secure storage.
 * This allows us to verify tokens without storing them in plaintext.
 */
function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export interface AuthResult {
  user: {
    userId: string;
    username: string;
    email: string;
    createdAt: Date;
    updatedAt: Date;
  };
  token: string;
  refreshToken: string;
}

export class AuthService {
  private readonly ACCESS_TOKEN_EXPIRY = '15m';
  private readonly REFRESH_TOKEN_EXPIRY = '30d';
  private readonly MAX_FAILED_ATTEMPTS = 5;
  private readonly LOCK_DURATION_MINUTES = 15;

  constructor(private readonly userRepository: UserRepository) {}

  async register(username: string, email: string, password: string): Promise<AuthResult> {
    // Normalize email and username for consistent storage and uniqueness checks
    const normalizedEmail = email.toLowerCase().trim();
    const normalizedUsername = username.toLowerCase().trim();

    // Validate username format
    if (!User.isValidUsername(normalizedUsername)) {
      throw new ValidationException(
        'Username must be 3-20 characters and contain only letters, numbers, and underscores'
      );
    }

    // Validate password length
    if (password.length < User.MIN_PASSWORD_LENGTH) {
      throw new ValidationException(
        `Password must be at least ${User.MIN_PASSWORD_LENGTH} characters`
      );
    }

    // Check if username already exists (using normalized form)
    const usernameExists = await this.userRepository.usernameExists(normalizedUsername);
    if (usernameExists) {
      throw new ConflictException('Username already taken');
    }

    // Check if email already exists (using normalized form)
    const emailExists = await this.userRepository.emailExists(normalizedEmail);
    if (emailExists) {
      throw new ConflictException('Email already in use');
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 10);

    // Create user with normalized values
    const user = await this.userRepository.create(normalizedUsername, normalizedEmail, passwordHash);

    // Generate tokens
    const accessToken = this.generateAccessToken(user);
    const refreshToken = this.generateRefreshToken(user);

    // Store hashed refresh token in database (never store tokens in plaintext)
    const refreshExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days
    await this.userRepository.updateRefreshToken(user.userId, hashToken(refreshToken), refreshExpiry);

    return {
      user: user.toSafeObject(),
      token: accessToken,
      refreshToken,
    };
  }

  async login(username: string, password: string): Promise<AuthResult> {
    // Find user
    const user = await this.userRepository.findByUsername(username);
    if (!user) {
      throw new InvalidCredentialsException('Invalid credentials');
    }

    // Check if account is locked - return generic message to prevent username enumeration
    const isLocked = await this.userRepository.isAccountLocked(user.userId);
    if (isLocked) {
      throw new InvalidCredentialsException('Invalid credentials');
    }

    // Verify password
    const isValid = await bcrypt.compare(password, user.passwordHash);
    if (!isValid) {
      // Increment failed attempts
      const failedAttempts = await this.userRepository.incrementFailedAttempts(user.userId);

      // Lock account if max attempts reached
      if (failedAttempts >= this.MAX_FAILED_ATTEMPTS) {
        await this.userRepository.lockAccount(user.userId, this.LOCK_DURATION_MINUTES);
      }

      throw new InvalidCredentialsException('Invalid credentials');
    }

    // Password is valid - reset failed attempts
    await this.userRepository.resetFailedAttempts(user.userId);

    // Generate tokens
    const accessToken = this.generateAccessToken(user);
    const refreshToken = this.generateRefreshToken(user);

    // Store hashed refresh token in database (never store tokens in plaintext)
    const refreshExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days
    await this.userRepository.updateRefreshToken(user.userId, hashToken(refreshToken), refreshExpiry);

    return {
      user: user.toSafeObject(),
      token: accessToken,
      refreshToken,
    };
  }

  async getCurrentUser(userId: string): Promise<{
    userId: string;
    username: string;
    email: string;
    createdAt: Date;
    updatedAt: Date;
  }> {
    const user = await this.userRepository.findById(userId);
    if (!user) {
      throw new InvalidCredentialsException('User not found');
    }

    return user.toSafeObject();
  }

  async refreshAccessToken(refreshToken: string): Promise<AuthResult> {
    try {
      const payload = verifyToken(refreshToken);

      // Reject access tokens used at the refresh endpoint
      if (payload.type !== 'refresh') {
        throw new InvalidCredentialsException('Invalid refresh token');
      }

      const user = await this.userRepository.findById(payload.sub);
      if (!user) {
        throw new InvalidCredentialsException('Invalid refresh token');
      }

      // Validate that this refresh token matches the stored hash AND is not expired
      const { token: storedHash, expiresAt } = await this.userRepository.getRefreshTokenWithExpiry(
        user.userId
      );
      // Compare hashes - stored token is hashed, so hash the incoming token
      if (storedHash !== hashToken(refreshToken)) {
        throw new InvalidCredentialsException('Invalid refresh token');
      }

      // Check if refresh token has expired in the database
      if (!expiresAt || expiresAt < new Date()) {
        throw new InvalidCredentialsException('Refresh token has expired');
      }

      const newAccessToken = this.generateAccessToken(user);
      const newRefreshToken = this.generateRefreshToken(user);

      // Store new hashed refresh token
      const refreshExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days
      await this.userRepository.updateRefreshToken(user.userId, hashToken(newRefreshToken), refreshExpiry);

      return {
        user: user.toSafeObject(),
        token: newAccessToken,
        refreshToken: newRefreshToken,
      };
    } catch (_error) {
      throw new InvalidCredentialsException('Invalid refresh token');
    }
  }

  async logout(userId: string): Promise<void> {
    await this.userRepository.clearRefreshToken(userId);
  }

  async searchUsers(
    query: string,
    currentUserId: string
  ): Promise<
    Array<{
      userId: string;
      username: string;
      email: string;
      createdAt: Date;
      updatedAt: Date;
    }>
  > {
    const users = await this.userRepository.searchByUsername(query, currentUserId);
    return users.map((user) => user.toSafeObject());
  }

  private generateAccessToken(user: User): string {
    return signToken(
      { sub: user.userId, userId: user.userId, username: user.username, type: 'access' },
      { expiresIn: this.ACCESS_TOKEN_EXPIRY }
    );
  }

  private generateRefreshToken(user: User): string {
    return signToken(
      { sub: user.userId, userId: user.userId, username: user.username, type: 'refresh' },
      { expiresIn: this.REFRESH_TOKEN_EXPIRY }
    );
  }
}
