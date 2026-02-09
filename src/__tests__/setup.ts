import { container } from '../container';

// Mock uuid module to avoid ESM issues in Jest
jest.mock('uuid', () => ({
  v4: jest.fn().mockReturnValue('00000000-0000-0000-0000-000000000000'),
}));

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

// Mock event bus for tests
jest.mock('../shared/events', () => ({
  tryGetEventBus: jest.fn(() => ({
    publish: jest.fn().mockReturnValue({ catch: jest.fn() }),
    rollbackTransaction: jest.fn(),
    beginTransaction: jest.fn(),
    commitTransaction: jest.fn(),
  })),
  EventTypes: {
    MEMBER_JOINED: 'MEMBER_JOINED',
    MEMBER_LEFT: 'MEMBER_LEFT',
    MEMBER_KICKED: 'MEMBER_KICKED',
    MEMBER_REINSTATED: 'MEMBER_REINSTATED',
  },
}));

// Mock Socket.IO service for tests
jest.mock('../socket', () => ({
  tryGetSocketService: jest.fn().mockReturnValue({
    // Waiver events
    emitWaiverClaimSuccessful: jest.fn(),
    emitWaiverClaimFailed: jest.fn(),
    emitWaiverPriorityUpdate: jest.fn(),
    // Trade events
    emitTradeProposed: jest.fn(),
    emitTradeAccepted: jest.fn(),
    emitTradeRejected: jest.fn(),
    emitTradeCancelled: jest.fn(),
    emitTradeInvalidated: jest.fn(),
    // Draft events
    emitDraftUpdate: jest.fn(),
    emitDraftSettingsUpdated: jest.fn(),
    emitPickMade: jest.fn(),
    emitNewPick: jest.fn(),
    emitNextPick: jest.fn(),
    emitDraftPick: jest.fn(),
    emitDraftCompleted: jest.fn(),
    emitQueueUpdated: jest.fn(),
    // Auction events
    emitAuctionUpdate: jest.fn(),
  }),
  getSocketService: jest.fn().mockImplementation(() => {
    throw new Error('Socket service not initialized in tests');
  }),
  initializeSocket: jest.fn(),
  closeSocket: jest.fn(),
  SocketService: jest.fn(),
}));
