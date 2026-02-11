import { PoolClient } from 'pg';
import { RosterMutationService } from '../../../modules/rosters/roster-mutation.service';
import { RosterPlayersRepository } from '../../../modules/rosters/rosters.repository';
import { LeagueRepository } from '../../../modules/leagues/leagues.repository';
import { League } from '../../../modules/leagues/leagues.model';
import { RosterPlayer } from '../../../modules/rosters/rosters.model';
import {
  ConflictException,
  NotFoundException,
  ValidationException,
} from '../../../utils/exceptions';

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

const createMockRosterPlayersRepo = (): jest.Mocked<RosterPlayersRepository> =>
  ({
    findOwner: jest.fn(),
    findByRosterAndPlayer: jest.fn(),
    addPlayer: jest.fn(),
    removePlayer: jest.fn(),
    getPlayerCount: jest.fn(),
    getByRosterId: jest.fn(),
    getFreeAgents: jest.fn(),
    addDraftedPlayer: jest.fn(),
    deleteAllByRosterId: jest.fn(),
    getPlayerIdsByRoster: jest.fn(),
    getOwnedPlayerIdsByLeague: jest.fn(),
  }) as unknown as jest.Mocked<RosterPlayersRepository>;

const createMockLeagueRepo = (): jest.Mocked<LeagueRepository> =>
  ({
    findById: jest.fn(),
    findByUserId: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    isUserMember: jest.fn(),
    isCommissioner: jest.fn(),
  }) as unknown as jest.Mocked<LeagueRepository>;

const mockClient = {} as PoolClient;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRosterPlayer(overrides: Partial<RosterPlayer> = {}): RosterPlayer {
  return {
    id: 1,
    rosterId: 100,
    playerId: 200,
    acquiredType: 'free_agent',
    acquiredAt: new Date('2025-01-01'),
    ...overrides,
  };
}

function makeLeague(settingsOverrides: Record<string, any> = {}): League {
  return new League(
    1,            // id
    'Test League', // name
    'active',     // status
    { roster_size: 15, ...settingsOverrides }, // settings
    {},           // scoringSettings
    '2025',       // season
    12,           // totalRosters
    new Date(),   // createdAt
    new Date()    // updatedAt
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RosterMutationService', () => {
  let service: RosterMutationService;
  let mockRosterPlayersRepo: jest.Mocked<RosterPlayersRepository>;
  let mockLeagueRepo: jest.Mocked<LeagueRepository>;

  beforeEach(() => {
    mockRosterPlayersRepo = createMockRosterPlayersRepo();
    mockLeagueRepo = createMockLeagueRepo();
    service = new RosterMutationService(mockRosterPlayersRepo, mockLeagueRepo);
  });

  // =========================================================================
  // addPlayerToRoster
  // =========================================================================
  describe('addPlayerToRoster', () => {
    const baseParams = {
      rosterId: 100,
      playerId: 200,
      leagueId: 1,
      acquiredType: 'free_agent' as const,
    };

    it('should add a player successfully when all validations pass', async () => {
      const expected = makeRosterPlayer();
      mockRosterPlayersRepo.findOwner.mockResolvedValue(null);
      mockLeagueRepo.findById.mockResolvedValue(makeLeague());
      mockRosterPlayersRepo.getPlayerCount.mockResolvedValue(10);
      mockRosterPlayersRepo.addPlayer.mockResolvedValue(expected);

      const result = await service.addPlayerToRoster(baseParams);

      expect(result).toEqual(expected);
      expect(mockRosterPlayersRepo.findOwner).toHaveBeenCalledWith(1, 200, undefined);
      expect(mockLeagueRepo.findById).toHaveBeenCalledWith(1, undefined);
      expect(mockRosterPlayersRepo.getPlayerCount).toHaveBeenCalledWith(100, undefined);
      expect(mockRosterPlayersRepo.addPlayer).toHaveBeenCalledWith(100, 200, 'free_agent', undefined);
    });

    it('should throw ConflictException when player is already owned', async () => {
      mockRosterPlayersRepo.findOwner.mockResolvedValue(999); // owned by roster 999

      await expect(service.addPlayerToRoster(baseParams)).rejects.toThrow(ConflictException);
      await expect(service.addPlayerToRoster(baseParams)).rejects.toThrow(
        'Player is already on a roster'
      );
      expect(mockRosterPlayersRepo.addPlayer).not.toHaveBeenCalled();
    });

    it('should throw ValidationException when roster is full', async () => {
      mockRosterPlayersRepo.findOwner.mockResolvedValue(null);
      mockLeagueRepo.findById.mockResolvedValue(makeLeague({ roster_size: 15 }));
      mockRosterPlayersRepo.getPlayerCount.mockResolvedValue(15);

      await expect(service.addPlayerToRoster(baseParams)).rejects.toThrow(ValidationException);
      await expect(service.addPlayerToRoster(baseParams)).rejects.toThrow('Roster is full');
      expect(mockRosterPlayersRepo.addPlayer).not.toHaveBeenCalled();
    });

    it('should throw NotFoundException when league is not found during size check', async () => {
      mockRosterPlayersRepo.findOwner.mockResolvedValue(null);
      mockLeagueRepo.findById.mockResolvedValue(null);

      await expect(service.addPlayerToRoster(baseParams)).rejects.toThrow(NotFoundException);
      await expect(service.addPlayerToRoster(baseParams)).rejects.toThrow('League not found');
    });

    it('should skip ownership check when skipOwnershipCheck is true', async () => {
      const expected = makeRosterPlayer();
      mockLeagueRepo.findById.mockResolvedValue(makeLeague());
      mockRosterPlayersRepo.getPlayerCount.mockResolvedValue(5);
      mockRosterPlayersRepo.addPlayer.mockResolvedValue(expected);

      const result = await service.addPlayerToRoster(baseParams, {
        skipOwnershipCheck: true,
      });

      expect(result).toEqual(expected);
      expect(mockRosterPlayersRepo.findOwner).not.toHaveBeenCalled();
    });

    it('should skip roster size check when skipRosterSizeCheck is true', async () => {
      const expected = makeRosterPlayer();
      mockRosterPlayersRepo.findOwner.mockResolvedValue(null);
      mockRosterPlayersRepo.addPlayer.mockResolvedValue(expected);

      const result = await service.addPlayerToRoster(baseParams, {
        skipRosterSizeCheck: true,
      });

      expect(result).toEqual(expected);
      expect(mockLeagueRepo.findById).not.toHaveBeenCalled();
      expect(mockRosterPlayersRepo.getPlayerCount).not.toHaveBeenCalled();
    });

    it('should forward transaction client to all repository calls', async () => {
      const expected = makeRosterPlayer();
      mockRosterPlayersRepo.findOwner.mockResolvedValue(null);
      mockLeagueRepo.findById.mockResolvedValue(makeLeague());
      mockRosterPlayersRepo.getPlayerCount.mockResolvedValue(5);
      mockRosterPlayersRepo.addPlayer.mockResolvedValue(expected);

      await service.addPlayerToRoster(baseParams, {}, mockClient);

      expect(mockRosterPlayersRepo.findOwner).toHaveBeenCalledWith(1, 200, mockClient);
      expect(mockLeagueRepo.findById).toHaveBeenCalledWith(1, mockClient);
      expect(mockRosterPlayersRepo.getPlayerCount).toHaveBeenCalledWith(100, mockClient);
      expect(mockRosterPlayersRepo.addPlayer).toHaveBeenCalledWith(
        100,
        200,
        'free_agent',
        mockClient
      );
    });
  });

  // =========================================================================
  // removePlayerFromRoster
  // =========================================================================
  describe('removePlayerFromRoster', () => {
    const baseParams = { rosterId: 100, playerId: 200 };

    it('should remove a player successfully when player exists on roster', async () => {
      mockRosterPlayersRepo.findByRosterAndPlayer.mockResolvedValue(makeRosterPlayer());
      mockRosterPlayersRepo.removePlayer.mockResolvedValue(true);

      await service.removePlayerFromRoster(baseParams);

      expect(mockRosterPlayersRepo.findByRosterAndPlayer).toHaveBeenCalledWith(
        100,
        200,
        undefined
      );
      expect(mockRosterPlayersRepo.removePlayer).toHaveBeenCalledWith(100, 200, undefined);
    });

    it('should throw NotFoundException when player is not on roster', async () => {
      mockRosterPlayersRepo.findByRosterAndPlayer.mockResolvedValue(null);

      await expect(service.removePlayerFromRoster(baseParams)).rejects.toThrow(NotFoundException);
      await expect(service.removePlayerFromRoster(baseParams)).rejects.toThrow(
        'Player is not on this roster'
      );
      expect(mockRosterPlayersRepo.removePlayer).not.toHaveBeenCalled();
    });

    it('should forward transaction client to repository calls', async () => {
      mockRosterPlayersRepo.findByRosterAndPlayer.mockResolvedValue(makeRosterPlayer());
      mockRosterPlayersRepo.removePlayer.mockResolvedValue(true);

      await service.removePlayerFromRoster(baseParams, mockClient);

      expect(mockRosterPlayersRepo.findByRosterAndPlayer).toHaveBeenCalledWith(
        100,
        200,
        mockClient
      );
      expect(mockRosterPlayersRepo.removePlayer).toHaveBeenCalledWith(100, 200, mockClient);
    });
  });

  // =========================================================================
  // swapPlayers
  // =========================================================================
  describe('swapPlayers', () => {
    const baseParams = {
      rosterId: 100,
      addPlayerId: 300,
      dropPlayerId: 200,
      leagueId: 1,
      acquiredType: 'waiver' as const,
    };

    it('should atomically drop one player and add another', async () => {
      const newRosterPlayer = makeRosterPlayer({ playerId: 300, acquiredType: 'waiver' });
      mockRosterPlayersRepo.findOwner.mockResolvedValue(null); // addPlayer not owned
      mockRosterPlayersRepo.findByRosterAndPlayer.mockResolvedValue(makeRosterPlayer()); // dropPlayer exists
      mockRosterPlayersRepo.removePlayer.mockResolvedValue(true);
      mockRosterPlayersRepo.addPlayer.mockResolvedValue(newRosterPlayer);

      const result = await service.swapPlayers(baseParams);

      expect(result).toEqual(newRosterPlayer);
      // Verify ownership check is on the add player
      expect(mockRosterPlayersRepo.findOwner).toHaveBeenCalledWith(1, 300, undefined);
      // Verify existence check is on the drop player
      expect(mockRosterPlayersRepo.findByRosterAndPlayer).toHaveBeenCalledWith(
        100,
        200,
        undefined
      );
      // Verify drop happens before add
      const removeCallOrder = mockRosterPlayersRepo.removePlayer.mock.invocationCallOrder[0];
      const addCallOrder = mockRosterPlayersRepo.addPlayer.mock.invocationCallOrder[0];
      expect(removeCallOrder).toBeLessThan(addCallOrder);
      // Verify correct args
      expect(mockRosterPlayersRepo.removePlayer).toHaveBeenCalledWith(100, 200, undefined);
      expect(mockRosterPlayersRepo.addPlayer).toHaveBeenCalledWith(100, 300, 'waiver', undefined);
    });

    it('should throw ConflictException when add player is already owned', async () => {
      mockRosterPlayersRepo.findOwner.mockResolvedValue(999);

      await expect(service.swapPlayers(baseParams)).rejects.toThrow(ConflictException);
      await expect(service.swapPlayers(baseParams)).rejects.toThrow(
        'Player is already on a roster'
      );
      expect(mockRosterPlayersRepo.removePlayer).not.toHaveBeenCalled();
      expect(mockRosterPlayersRepo.addPlayer).not.toHaveBeenCalled();
    });

    it('should throw NotFoundException when drop player is not on roster', async () => {
      mockRosterPlayersRepo.findOwner.mockResolvedValue(null);
      mockRosterPlayersRepo.findByRosterAndPlayer.mockResolvedValue(null);

      await expect(service.swapPlayers(baseParams)).rejects.toThrow(NotFoundException);
      await expect(service.swapPlayers(baseParams)).rejects.toThrow(
        'Player to drop is not on this roster'
      );
      expect(mockRosterPlayersRepo.removePlayer).not.toHaveBeenCalled();
      expect(mockRosterPlayersRepo.addPlayer).not.toHaveBeenCalled();
    });

    it('should forward transaction client to all repository calls', async () => {
      const newRosterPlayer = makeRosterPlayer({ playerId: 300, acquiredType: 'waiver' });
      mockRosterPlayersRepo.findOwner.mockResolvedValue(null);
      mockRosterPlayersRepo.findByRosterAndPlayer.mockResolvedValue(makeRosterPlayer());
      mockRosterPlayersRepo.removePlayer.mockResolvedValue(true);
      mockRosterPlayersRepo.addPlayer.mockResolvedValue(newRosterPlayer);

      await service.swapPlayers(baseParams, mockClient);

      expect(mockRosterPlayersRepo.findOwner).toHaveBeenCalledWith(1, 300, mockClient);
      expect(mockRosterPlayersRepo.findByRosterAndPlayer).toHaveBeenCalledWith(
        100,
        200,
        mockClient
      );
      expect(mockRosterPlayersRepo.removePlayer).toHaveBeenCalledWith(100, 200, mockClient);
      expect(mockRosterPlayersRepo.addPlayer).toHaveBeenCalledWith(100, 300, 'waiver', mockClient);
    });
  });

  // =========================================================================
  // bulkRemovePlayers
  // =========================================================================
  describe('bulkRemovePlayers', () => {
    it('should remove multiple players successfully', async () => {
      const removals = [
        { rosterId: 100, playerId: 200 },
        { rosterId: 101, playerId: 201 },
        { rosterId: 102, playerId: 202 },
      ];
      // All players exist
      mockRosterPlayersRepo.findByRosterAndPlayer
        .mockResolvedValueOnce(makeRosterPlayer({ rosterId: 100, playerId: 200 }))
        .mockResolvedValueOnce(makeRosterPlayer({ rosterId: 101, playerId: 201 }))
        .mockResolvedValueOnce(makeRosterPlayer({ rosterId: 102, playerId: 202 }));
      mockRosterPlayersRepo.removePlayer.mockResolvedValue(true);

      await service.bulkRemovePlayers({ leagueId: 1, removals });

      expect(mockRosterPlayersRepo.findByRosterAndPlayer).toHaveBeenCalledTimes(3);
      expect(mockRosterPlayersRepo.removePlayer).toHaveBeenCalledTimes(3);
      expect(mockRosterPlayersRepo.removePlayer).toHaveBeenCalledWith(100, 200, undefined);
      expect(mockRosterPlayersRepo.removePlayer).toHaveBeenCalledWith(101, 201, undefined);
      expect(mockRosterPlayersRepo.removePlayer).toHaveBeenCalledWith(102, 202, undefined);
    });

    it('should throw ConflictException when one player is not found and remove none', async () => {
      const removals = [
        { rosterId: 100, playerId: 200 },
        { rosterId: 101, playerId: 201 }, // this one missing
        { rosterId: 102, playerId: 202 },
      ];
      mockRosterPlayersRepo.findByRosterAndPlayer
        .mockResolvedValueOnce(makeRosterPlayer({ rosterId: 100, playerId: 200 }))
        .mockResolvedValueOnce(null) // missing
        .mockResolvedValueOnce(makeRosterPlayer({ rosterId: 102, playerId: 202 }));

      const error = await service.bulkRemovePlayers({ leagueId: 1, removals }).catch((e: any) => e);
      expect(error).toBeInstanceOf(ConflictException);
      expect(error.message).toContain('Player 201 is no longer on roster 101');
      // No removals should have occurred
      expect(mockRosterPlayersRepo.removePlayer).not.toHaveBeenCalled();
    });

    it('should forward transaction client to repository calls', async () => {
      const removals = [{ rosterId: 100, playerId: 200 }];
      mockRosterPlayersRepo.findByRosterAndPlayer.mockResolvedValue(makeRosterPlayer());
      mockRosterPlayersRepo.removePlayer.mockResolvedValue(true);

      await service.bulkRemovePlayers({ leagueId: 1, removals }, mockClient);

      expect(mockRosterPlayersRepo.findByRosterAndPlayer).toHaveBeenCalledWith(
        100,
        200,
        mockClient
      );
      expect(mockRosterPlayersRepo.removePlayer).toHaveBeenCalledWith(100, 200, mockClient);
    });
  });

  // =========================================================================
  // bulkAddPlayers
  // =========================================================================
  describe('bulkAddPlayers', () => {
    const league = makeLeague({ roster_size: 15 });

    it('should add multiple players successfully', async () => {
      const additions = [
        { rosterId: 100, playerId: 300, acquiredType: 'trade' as const },
        { rosterId: 101, playerId: 301, acquiredType: 'trade' as const },
      ];
      mockLeagueRepo.findById.mockResolvedValue(league);
      mockRosterPlayersRepo.getPlayerCount
        .mockResolvedValueOnce(10)
        .mockResolvedValueOnce(12);
      mockRosterPlayersRepo.addPlayer
        .mockResolvedValueOnce(makeRosterPlayer({ rosterId: 100, playerId: 300, acquiredType: 'trade' }))
        .mockResolvedValueOnce(makeRosterPlayer({ rosterId: 101, playerId: 301, acquiredType: 'trade' }));

      const result = await service.bulkAddPlayers({ leagueId: 1, additions });

      expect(result).toHaveLength(2);
      expect(result[0].playerId).toBe(300);
      expect(result[1].playerId).toBe(301);
      expect(mockLeagueRepo.findById).toHaveBeenCalledWith(1, undefined);
      expect(mockRosterPlayersRepo.getPlayerCount).toHaveBeenCalledTimes(2);
      expect(mockRosterPlayersRepo.addPlayer).toHaveBeenCalledTimes(2);
    });

    it('should throw NotFoundException when league is not found', async () => {
      mockLeagueRepo.findById.mockResolvedValue(null);

      await expect(
        service.bulkAddPlayers({
          leagueId: 999,
          additions: [{ rosterId: 100, playerId: 300, acquiredType: 'trade' }],
        })
      ).rejects.toThrow(NotFoundException);
      await expect(
        service.bulkAddPlayers({
          leagueId: 999,
          additions: [{ rosterId: 100, playerId: 300, acquiredType: 'trade' }],
        })
      ).rejects.toThrow('League not found');
    });

    it('should throw ValidationException when one roster is full and stop processing', async () => {
      const additions = [
        { rosterId: 100, playerId: 300, acquiredType: 'trade' as const },
        { rosterId: 101, playerId: 301, acquiredType: 'trade' as const }, // this one full
      ];
      mockLeagueRepo.findById.mockResolvedValue(league);
      mockRosterPlayersRepo.getPlayerCount
        .mockResolvedValueOnce(10) // first roster OK
        .mockResolvedValueOnce(15); // second roster full (15 >= 15)
      mockRosterPlayersRepo.addPlayer.mockResolvedValueOnce(
        makeRosterPlayer({ rosterId: 100, playerId: 300, acquiredType: 'trade' })
      );

      const error = await service.bulkAddPlayers({ leagueId: 1, additions }).catch((e: any) => e);
      expect(error).toBeInstanceOf(ValidationException);
      expect(error.message).toContain('Roster 101 is full');

      // First add should have been attempted before the second fails
      // (reset mocks to verify accurately)
    });

    it('should use league settings for max roster size', async () => {
      const smallLeague = makeLeague({ roster_size: 5 });
      const additions = [
        { rosterId: 100, playerId: 300, acquiredType: 'trade' as const },
      ];
      mockLeagueRepo.findById.mockResolvedValue(smallLeague);
      mockRosterPlayersRepo.getPlayerCount.mockResolvedValue(5);

      await expect(
        service.bulkAddPlayers({ leagueId: 1, additions })
      ).rejects.toThrow(ValidationException);
      await expect(
        service.bulkAddPlayers({ leagueId: 1, additions })
      ).rejects.toThrow('Roster 100 is full');
    });

    it('should forward transaction client to all repository calls', async () => {
      const additions = [
        { rosterId: 100, playerId: 300, acquiredType: 'trade' as const },
      ];
      mockLeagueRepo.findById.mockResolvedValue(league);
      mockRosterPlayersRepo.getPlayerCount.mockResolvedValue(5);
      mockRosterPlayersRepo.addPlayer.mockResolvedValue(
        makeRosterPlayer({ rosterId: 100, playerId: 300, acquiredType: 'trade' })
      );

      await service.bulkAddPlayers({ leagueId: 1, additions }, mockClient);

      expect(mockLeagueRepo.findById).toHaveBeenCalledWith(1, mockClient);
      expect(mockRosterPlayersRepo.getPlayerCount).toHaveBeenCalledWith(100, mockClient);
      expect(mockRosterPlayersRepo.addPlayer).toHaveBeenCalledWith(
        100,
        300,
        'trade',
        mockClient
      );
    });
  });
});
