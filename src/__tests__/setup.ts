import { container } from '../container';

// Clear all cached instances before each test
beforeEach(() => {
  container.clearInstances();
});

// Mock bcrypt for faster tests
jest.mock('bcrypt', () => ({
  hash: jest.fn().mockResolvedValue('hashed_password'),
  compare: jest.fn().mockImplementation((password, _hash) => {
    // Return true if password is 'correct_password', false otherwise
    return Promise.resolve(password === 'correct_password');
  }),
}));

// Mock JWT utils
jest.mock('../utils/jwt', () => ({
  signToken: jest.fn().mockReturnValue('mock_token'),
  verifyToken: jest.fn().mockImplementation((token) => {
    if (token === 'valid_refresh_token') {
      return { sub: 'user-123', userId: 'user-123', username: 'testuser' };
    }
    throw new Error('Invalid token');
  }),
}));
