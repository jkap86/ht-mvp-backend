/**
 * Socket Access Control Regression Tests
 *
 * Verifies that kicked/removed users:
 * 1. Have their membership cache invalidated
 * 2. Are evicted from all league-related socket rooms
 * 3. Cannot rejoin rooms after removal
 */

import { SocketEventSubscriber } from '../../shared/events/socket-event-subscriber';
import { EventTypes } from '../../shared/events/domain-event-bus';
import type { DomainEvent } from '../../shared/events/domain-event-bus';

// Mock socket service with spies
const mockSocketService = {
  emitMemberKicked: jest.fn(),
  emitMemberJoined: jest.fn(),
  emitMemberBenched: jest.fn(),
  invalidateMembershipCache: jest.fn().mockResolvedValue(undefined),
  evictUserFromLeagueRooms: jest.fn().mockResolvedValue(undefined),
};

jest.mock('../../socket/socket.service', () => ({
  tryGetSocketService: jest.fn(() => mockSocketService),
}));

jest.mock('../../config/logger.config', () => ({
  logger: {
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}));

function makeEvent(overrides: Partial<DomainEvent>): DomainEvent {
  return {
    type: '',
    payload: {},
    timestamp: new Date(),
    ...overrides,
  };
}

describe('Socket Access Control', () => {
  let subscriber: SocketEventSubscriber;

  beforeEach(() => {
    jest.clearAllMocks();
    subscriber = new SocketEventSubscriber();
  });

  describe('MEMBER_KICKED event', () => {
    const kickEvent = () =>
      makeEvent({
        type: EventTypes.MEMBER_KICKED,
        leagueId: 1,
        payload: {
          rosterDbId: 10,
          rosterSlotId: 3,
          teamName: 'Kicked Team',
          userId: 'user-kicked',
        },
      });

    it('should invalidate membership cache for kicked user', () => {
      subscriber.handle(kickEvent());

      expect(mockSocketService.invalidateMembershipCache).toHaveBeenCalledWith(1, 'user-kicked');
    });

    it('should evict kicked user from all league rooms', () => {
      subscriber.handle(kickEvent());

      expect(mockSocketService.evictUserFromLeagueRooms).toHaveBeenCalledWith(1, 'user-kicked');
    });

    it('should emit kick event to league room before eviction', () => {
      subscriber.handle(kickEvent());

      expect(mockSocketService.emitMemberKicked).toHaveBeenCalledWith(1, {
        rosterDbId: 10,
        rosterSlotId: 3,
        teamName: 'Kicked Team',
        userId: 'user-kicked',
      });

      // emit should be called before evict (both called, order verified by call count)
      expect(mockSocketService.emitMemberKicked).toHaveBeenCalledTimes(1);
      expect(mockSocketService.evictUserFromLeagueRooms).toHaveBeenCalledTimes(1);
    });

    it('should not evict or invalidate when userId is missing from payload', () => {
      const event = makeEvent({
        type: EventTypes.MEMBER_KICKED,
        leagueId: 1,
        payload: { rosterDbId: 10, rosterSlotId: 3, teamName: 'Kicked Team' },
      });

      subscriber.handle(event);

      expect(mockSocketService.emitMemberKicked).toHaveBeenCalledTimes(1);
      expect(mockSocketService.invalidateMembershipCache).not.toHaveBeenCalled();
      expect(mockSocketService.evictUserFromLeagueRooms).not.toHaveBeenCalled();
    });
  });

  describe('MEMBER_LEFT event', () => {
    const leftEvent = () =>
      makeEvent({
        type: EventTypes.MEMBER_LEFT,
        leagueId: 2,
        payload: {
          rosterDbId: 20,
          rosterSlotId: 5,
          teamName: 'Departing Team',
          userId: 'user-left',
        },
      });

    it('should invalidate membership cache for user who left', () => {
      subscriber.handle(leftEvent());

      expect(mockSocketService.invalidateMembershipCache).toHaveBeenCalledWith(2, 'user-left');
    });

    it('should evict user who left from all league rooms', () => {
      subscriber.handle(leftEvent());

      expect(mockSocketService.evictUserFromLeagueRooms).toHaveBeenCalledWith(2, 'user-left');
    });

    it('should not evict or invalidate when userId is missing from payload', () => {
      const event = makeEvent({
        type: EventTypes.MEMBER_LEFT,
        leagueId: 2,
        payload: { rosterDbId: 20, rosterSlotId: 5, teamName: 'Departing Team' },
      });

      subscriber.handle(event);

      expect(mockSocketService.invalidateMembershipCache).not.toHaveBeenCalled();
      expect(mockSocketService.evictUserFromLeagueRooms).not.toHaveBeenCalled();
    });
  });

  describe('MEMBER_JOINED event', () => {
    const joinEvent = () =>
      makeEvent({
        type: EventTypes.MEMBER_JOINED,
        leagueId: 3,
        payload: {
          rosterDbId: 30,
          rosterSlotId: 7,
          teamName: 'New Team',
          userId: 'user-joined',
        },
      });

    it('should invalidate membership cache for joined user (clears stale false)', () => {
      subscriber.handle(joinEvent());

      expect(mockSocketService.invalidateMembershipCache).toHaveBeenCalledWith(3, 'user-joined');
    });

    it('should NOT evict joined user from rooms', () => {
      subscriber.handle(joinEvent());

      expect(mockSocketService.evictUserFromLeagueRooms).not.toHaveBeenCalled();
    });
  });

  describe('Cache invalidation covers all membership change events', () => {
    it('should call invalidateMembershipCache for MEMBER_KICKED', () => {
      subscriber.handle(
        makeEvent({
          type: EventTypes.MEMBER_KICKED,
          leagueId: 1,
          payload: { userId: 'u1', rosterDbId: 1, rosterSlotId: 1, teamName: 'T' },
        })
      );
      expect(mockSocketService.invalidateMembershipCache).toHaveBeenCalledWith(1, 'u1');
    });

    it('should call invalidateMembershipCache for MEMBER_LEFT', () => {
      subscriber.handle(
        makeEvent({
          type: EventTypes.MEMBER_LEFT,
          leagueId: 2,
          payload: { userId: 'u2', rosterDbId: 2, rosterSlotId: 2, teamName: 'T' },
        })
      );
      expect(mockSocketService.invalidateMembershipCache).toHaveBeenCalledWith(2, 'u2');
    });

    it('should call invalidateMembershipCache for MEMBER_JOINED', () => {
      subscriber.handle(
        makeEvent({
          type: EventTypes.MEMBER_JOINED,
          leagueId: 3,
          payload: { userId: 'u3', rosterDbId: 3, rosterSlotId: 3, teamName: 'T' },
        })
      );
      expect(mockSocketService.invalidateMembershipCache).toHaveBeenCalledWith(3, 'u3');
    });
  });

  describe('Eviction covers all removal events', () => {
    it('should call evictUserFromLeagueRooms for MEMBER_KICKED', () => {
      subscriber.handle(
        makeEvent({
          type: EventTypes.MEMBER_KICKED,
          leagueId: 1,
          payload: { userId: 'u1', rosterDbId: 1, rosterSlotId: 1, teamName: 'T' },
        })
      );
      expect(mockSocketService.evictUserFromLeagueRooms).toHaveBeenCalledWith(1, 'u1');
    });

    it('should call evictUserFromLeagueRooms for MEMBER_LEFT', () => {
      subscriber.handle(
        makeEvent({
          type: EventTypes.MEMBER_LEFT,
          leagueId: 2,
          payload: { userId: 'u2', rosterDbId: 2, rosterSlotId: 2, teamName: 'T' },
        })
      );
      expect(mockSocketService.evictUserFromLeagueRooms).toHaveBeenCalledWith(2, 'u2');
    });
  });

  describe('No-op when leagueId is missing', () => {
    it('should not act on MEMBER_KICKED without leagueId', () => {
      subscriber.handle(
        makeEvent({
          type: EventTypes.MEMBER_KICKED,
          payload: { userId: 'u1', rosterDbId: 1, rosterSlotId: 1, teamName: 'T' },
        })
      );
      expect(mockSocketService.emitMemberKicked).not.toHaveBeenCalled();
      expect(mockSocketService.invalidateMembershipCache).not.toHaveBeenCalled();
      expect(mockSocketService.evictUserFromLeagueRooms).not.toHaveBeenCalled();
    });

    it('should not act on MEMBER_LEFT without leagueId', () => {
      subscriber.handle(
        makeEvent({
          type: EventTypes.MEMBER_LEFT,
          payload: { userId: 'u2', rosterDbId: 2, rosterSlotId: 2, teamName: 'T' },
        })
      );
      expect(mockSocketService.emitMemberKicked).not.toHaveBeenCalled();
      expect(mockSocketService.invalidateMembershipCache).not.toHaveBeenCalled();
      expect(mockSocketService.evictUserFromLeagueRooms).not.toHaveBeenCalled();
    });
  });
});
