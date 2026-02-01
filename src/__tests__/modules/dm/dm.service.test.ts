import { DmService } from '../../../modules/dm/dm.service';
import { DmRepository } from '../../../modules/dm/dm.repository';
import { UserRepository } from '../../../modules/auth/auth.repository';
import { User } from '../../../modules/auth/auth.model';
import {
  ValidationException,
  ForbiddenException,
  NotFoundException,
} from '../../../utils/exceptions';

// Mock socket service
jest.mock('../../../socket', () => ({
  tryGetSocketService: jest.fn(() => ({
    emitDmMessage: jest.fn(),
    emitDmRead: jest.fn(),
  })),
}));

// Mock logger
jest.mock('../../../config/logger.config', () => ({
  logger: {
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

// Mock user data
const mockUser = new User(
  'user-123',
  'testuser',
  'test@example.com',
  'hashed_password',
  new Date('2024-01-01'),
  new Date('2024-01-01')
);

const mockOtherUser = new User(
  'user-456',
  'otheruser',
  'other@example.com',
  'hashed_password',
  new Date('2024-01-01'),
  new Date('2024-01-01')
);

// Create mock DM repository
const createMockDmRepository = (): jest.Mocked<DmRepository> =>
  ({
    getConversationsForUser: jest.fn(),
    findOrCreateConversation: jest.fn(),
    getConversationBetweenUsers: jest.fn(),
    isUserParticipant: jest.fn(),
    getMessages: jest.fn(),
    createMessage: jest.fn(),
    markAsRead: jest.fn(),
    findById: jest.fn(),
    getOtherUserId: jest.fn(),
  }) as unknown as jest.Mocked<DmRepository>;

// Create mock user repository
const createMockUserRepository = (): jest.Mocked<UserRepository> =>
  ({
    findById: jest.fn(),
  }) as unknown as jest.Mocked<UserRepository>;

describe('DmService', () => {
  let dmService: DmService;
  let mockDmRepo: jest.Mocked<DmRepository>;
  let mockUserRepo: jest.Mocked<UserRepository>;

  beforeEach(() => {
    mockDmRepo = createMockDmRepository();
    mockUserRepo = createMockUserRepository();
    dmService = new DmService(mockDmRepo, mockUserRepo);
  });

  describe('getOrCreateConversation', () => {
    it('should create new conversation if none exists', async () => {
      mockUserRepo.findById.mockResolvedValue(mockOtherUser);
      mockDmRepo.findOrCreateConversation.mockResolvedValue({ id: 1 } as any);
      mockDmRepo.getConversationBetweenUsers.mockResolvedValue({
        id: 1,
        otherUserId: 'user-456',
        otherUsername: 'otheruser',
        lastMessage: null,
        unreadCount: 0,
        updatedAt: new Date(),
      });

      const result = await dmService.getOrCreateConversation('user-123', 'user-456');

      expect(result.id).toBe(1);
      expect(mockDmRepo.findOrCreateConversation).toHaveBeenCalledWith('user-123', 'user-456');
    });

    it('should return existing conversation', async () => {
      mockUserRepo.findById.mockResolvedValue(mockOtherUser);
      mockDmRepo.findOrCreateConversation.mockResolvedValue({ id: 1 } as any);
      mockDmRepo.getConversationBetweenUsers.mockResolvedValue({
        id: 1,
        otherUserId: 'user-456',
        otherUsername: 'otheruser',
        lastMessage: {
          id: 1,
          conversationId: 1,
          senderId: 'user-456',
          message: 'Hello',
          createdAt: new Date(),
          senderUsername: 'otheruser',
        },
        unreadCount: 2,
        updatedAt: new Date(),
      });

      const result = await dmService.getOrCreateConversation('user-123', 'user-456');

      expect(result.id).toBe(1);
      expect(result.unread_count).toBe(2);
    });

    it('should throw NotFoundException if other user does not exist', async () => {
      mockUserRepo.findById.mockResolvedValue(null);

      await expect(
        dmService.getOrCreateConversation('user-123', 'nonexistent-user')
      ).rejects.toThrow(NotFoundException);
      await expect(
        dmService.getOrCreateConversation('user-123', 'nonexistent-user')
      ).rejects.toThrow('User not found');
    });

    it('should throw ValidationException if trying to message self', async () => {
      mockUserRepo.findById.mockResolvedValue(mockUser);

      await expect(
        dmService.getOrCreateConversation('user-123', 'user-123')
      ).rejects.toThrow(ValidationException);
      await expect(
        dmService.getOrCreateConversation('user-123', 'user-123')
      ).rejects.toThrow('Cannot start a conversation with yourself');
    });
  });

  describe('sendMessage', () => {
    it('should create message and emit socket event', async () => {
      mockDmRepo.isUserParticipant.mockResolvedValue(true);
      mockDmRepo.createMessage.mockResolvedValue({
        id: 1,
        conversationId: 1,
        senderId: 'user-123',
        message: 'Hello',
        createdAt: new Date(),
        senderUsername: 'testuser',
      });
      mockDmRepo.findById.mockResolvedValue({
        id: 1,
        user1Id: 'user-123',
        user2Id: 'user-456',
      } as any);
      mockDmRepo.getOtherUserId.mockReturnValue('user-456');

      const result = await dmService.sendMessage('user-123', 1, 'Hello');

      expect(result.message).toBe('Hello');
      expect(mockDmRepo.createMessage).toHaveBeenCalledWith(1, 'user-123', 'Hello');
    });

    it('should validate message length after trim', async () => {
      mockDmRepo.isUserParticipant.mockResolvedValue(true);

      // Message with leading/trailing whitespace that is valid after trim
      mockDmRepo.createMessage.mockResolvedValue({
        id: 1,
        conversationId: 1,
        senderId: 'user-123',
        message: 'Hello',
        createdAt: new Date(),
        senderUsername: 'testuser',
      });
      mockDmRepo.findById.mockResolvedValue({
        id: 1,
        user1Id: 'user-123',
        user2Id: 'user-456',
      } as any);
      mockDmRepo.getOtherUserId.mockReturnValue('user-456');

      const result = await dmService.sendMessage('user-123', 1, '  Hello  ');

      expect(mockDmRepo.createMessage).toHaveBeenCalledWith(1, 'user-123', 'Hello');
    });

    it('should throw ValidationException for empty message', async () => {
      mockDmRepo.isUserParticipant.mockResolvedValue(true);

      await expect(dmService.sendMessage('user-123', 1, '')).rejects.toThrow(ValidationException);
      await expect(dmService.sendMessage('user-123', 1, '   ')).rejects.toThrow(
        'Message cannot be empty'
      );
    });

    it('should throw ValidationException for message exceeding 1000 characters', async () => {
      mockDmRepo.isUserParticipant.mockResolvedValue(true);
      const longMessage = 'a'.repeat(1001);

      await expect(dmService.sendMessage('user-123', 1, longMessage)).rejects.toThrow(
        ValidationException
      );
      await expect(dmService.sendMessage('user-123', 1, longMessage)).rejects.toThrow(
        'Message cannot exceed 1000 characters'
      );
    });

    it('should throw ForbiddenException if not participant', async () => {
      mockDmRepo.isUserParticipant.mockResolvedValue(false);

      await expect(dmService.sendMessage('user-123', 1, 'Hello')).rejects.toThrow(
        ForbiddenException
      );
      await expect(dmService.sendMessage('user-123', 1, 'Hello')).rejects.toThrow(
        'You are not a participant in this conversation'
      );
    });
  });

  describe('getMessages', () => {
    it('should return messages for conversation', async () => {
      mockDmRepo.isUserParticipant.mockResolvedValue(true);
      mockDmRepo.getMessages.mockResolvedValue([
        {
          id: 1,
          conversationId: 1,
          senderId: 'user-123',
          message: 'Hello',
          createdAt: new Date(),
          senderUsername: 'testuser',
        },
        {
          id: 2,
          conversationId: 1,
          senderId: 'user-456',
          message: 'Hi there',
          createdAt: new Date(),
          senderUsername: 'otheruser',
        },
      ]);

      const result = await dmService.getMessages('user-123', 1);

      expect(result).toHaveLength(2);
      expect(result[0].message).toBe('Hello');
      expect(result[1].message).toBe('Hi there');
    });

    it('should throw ForbiddenException if not participant', async () => {
      mockDmRepo.isUserParticipant.mockResolvedValue(false);

      await expect(dmService.getMessages('user-123', 1)).rejects.toThrow(ForbiddenException);
    });
  });

  describe('markAsRead', () => {
    it('should mark conversation as read and emit socket event', async () => {
      mockDmRepo.isUserParticipant.mockResolvedValue(true);
      mockDmRepo.markAsRead.mockResolvedValue(undefined);
      mockDmRepo.findById.mockResolvedValue({
        id: 1,
        user1Id: 'user-123',
        user2Id: 'user-456',
      } as any);
      mockDmRepo.getOtherUserId.mockReturnValue('user-456');

      await dmService.markAsRead('user-123', 1);

      expect(mockDmRepo.markAsRead).toHaveBeenCalledWith(1, 'user-123');
    });

    it('should throw ForbiddenException if not participant', async () => {
      mockDmRepo.isUserParticipant.mockResolvedValue(false);

      await expect(dmService.markAsRead('user-123', 1)).rejects.toThrow(ForbiddenException);
    });
  });

  describe('getTotalUnreadCount', () => {
    it('should return sum of unread counts', async () => {
      mockDmRepo.getConversationsForUser.mockResolvedValue([
        { id: 1, unreadCount: 3 } as any,
        { id: 2, unreadCount: 5 } as any,
        { id: 3, unreadCount: 0 } as any,
      ]);

      const result = await dmService.getTotalUnreadCount('user-123');

      expect(result).toBe(8);
    });

    it('should return 0 if no conversations', async () => {
      mockDmRepo.getConversationsForUser.mockResolvedValue([]);

      const result = await dmService.getTotalUnreadCount('user-123');

      expect(result).toBe(0);
    });
  });
});
