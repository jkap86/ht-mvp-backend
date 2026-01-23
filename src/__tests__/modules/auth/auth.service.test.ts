import { AuthService } from '../../../modules/auth/auth.service';
import { UserRepository } from '../../../modules/auth/auth.repository';
import { User } from '../../../modules/auth/auth.model';
import {
  ValidationException,
  InvalidCredentialsException,
  ConflictException,
} from '../../../utils/exceptions';

// Mock user data
const mockUser = new User(
  'user-123',
  'testuser',
  'test@example.com',
  'hashed_password',
  new Date('2024-01-01'),
  new Date('2024-01-01')
);

// Create mock repository
const createMockUserRepository = (): jest.Mocked<UserRepository> => ({
  findByUsername: jest.fn(),
  findById: jest.fn(),
  create: jest.fn(),
  emailExists: jest.fn(),
  usernameExists: jest.fn(),
  searchByUsername: jest.fn(),
} as unknown as jest.Mocked<UserRepository>);

describe('AuthService', () => {
  let authService: AuthService;
  let mockUserRepo: jest.Mocked<UserRepository>;

  beforeEach(() => {
    mockUserRepo = createMockUserRepository();
    authService = new AuthService(mockUserRepo);
  });

  describe('register', () => {
    it('should create user and return tokens on success', async () => {
      mockUserRepo.usernameExists.mockResolvedValue(false);
      mockUserRepo.emailExists.mockResolvedValue(false);
      mockUserRepo.create.mockResolvedValue(mockUser);

      const result = await authService.register('testuser', 'test@example.com', 'password123');

      expect(result.user.username).toBe('testuser');
      expect(result.user.email).toBe('test@example.com');
      expect(result.token).toBe('mock_token');
      expect(result.refreshToken).toBe('mock_token');
      expect(mockUserRepo.create).toHaveBeenCalledWith(
        'testuser',
        'test@example.com',
        'hashed_password'
      );
    });

    it('should throw ConflictException when username already exists', async () => {
      mockUserRepo.usernameExists.mockResolvedValue(true);

      await expect(
        authService.register('existinguser', 'test@example.com', 'password123')
      ).rejects.toThrow(ConflictException);
      await expect(
        authService.register('existinguser', 'test@example.com', 'password123')
      ).rejects.toThrow('Username already taken');
    });

    it('should throw ConflictException when email already exists', async () => {
      mockUserRepo.usernameExists.mockResolvedValue(false);
      mockUserRepo.emailExists.mockResolvedValue(true);

      await expect(
        authService.register('newuser', 'existing@example.com', 'password123')
      ).rejects.toThrow(ConflictException);
      await expect(
        authService.register('newuser', 'existing@example.com', 'password123')
      ).rejects.toThrow('Email already in use');
    });

    it('should throw ValidationException for invalid username format', async () => {
      await expect(
        authService.register('ab', 'test@example.com', 'password123')
      ).rejects.toThrow(ValidationException);
      await expect(
        authService.register('ab', 'test@example.com', 'password123')
      ).rejects.toThrow('Username must be 3-20 characters');
    });

    it('should throw ValidationException for password too short', async () => {
      await expect(
        authService.register('validuser', 'test@example.com', '12345')
      ).rejects.toThrow(ValidationException);
      await expect(
        authService.register('validuser', 'test@example.com', '12345')
      ).rejects.toThrow('Password must be at least');
    });
  });

  describe('login', () => {
    it('should return tokens on valid credentials', async () => {
      mockUserRepo.findByUsername.mockResolvedValue(mockUser);
      // bcrypt.compare is mocked to return true for 'correct_password'

      const result = await authService.login('testuser', 'correct_password');

      expect(result.user.username).toBe('testuser');
      expect(result.token).toBe('mock_token');
      expect(result.refreshToken).toBe('mock_token');
    });

    it('should throw InvalidCredentialsException for wrong password', async () => {
      mockUserRepo.findByUsername.mockResolvedValue(mockUser);

      await expect(
        authService.login('testuser', 'wrong_password')
      ).rejects.toThrow(InvalidCredentialsException);
      await expect(
        authService.login('testuser', 'wrong_password')
      ).rejects.toThrow('Invalid credentials');
    });

    it('should throw InvalidCredentialsException when user not found', async () => {
      mockUserRepo.findByUsername.mockResolvedValue(null);

      await expect(
        authService.login('nonexistent', 'password123')
      ).rejects.toThrow(InvalidCredentialsException);
      await expect(
        authService.login('nonexistent', 'password123')
      ).rejects.toThrow('Invalid credentials');
    });
  });

  describe('getCurrentUser', () => {
    it('should return user on success', async () => {
      mockUserRepo.findById.mockResolvedValue(mockUser);

      const result = await authService.getCurrentUser('user-123');

      expect(result.userId).toBe('user-123');
      expect(result.username).toBe('testuser');
      expect(result.email).toBe('test@example.com');
    });

    it('should throw InvalidCredentialsException when user not found', async () => {
      mockUserRepo.findById.mockResolvedValue(null);

      await expect(
        authService.getCurrentUser('nonexistent-id')
      ).rejects.toThrow(InvalidCredentialsException);
      await expect(
        authService.getCurrentUser('nonexistent-id')
      ).rejects.toThrow('User not found');
    });
  });

  describe('refreshAccessToken', () => {
    it('should return new tokens on valid refresh token', async () => {
      mockUserRepo.findById.mockResolvedValue(mockUser);

      const result = await authService.refreshAccessToken('valid_refresh_token');

      expect(result.user.username).toBe('testuser');
      expect(result.token).toBe('mock_token');
      expect(result.refreshToken).toBe('mock_token');
    });

    it('should throw InvalidCredentialsException on invalid refresh token', async () => {
      await expect(
        authService.refreshAccessToken('invalid_token')
      ).rejects.toThrow(InvalidCredentialsException);
      await expect(
        authService.refreshAccessToken('invalid_token')
      ).rejects.toThrow('Invalid refresh token');
    });

    it('should throw InvalidCredentialsException when user not found after token verification', async () => {
      mockUserRepo.findById.mockResolvedValue(null);

      await expect(
        authService.refreshAccessToken('valid_refresh_token')
      ).rejects.toThrow(InvalidCredentialsException);
    });
  });
});
