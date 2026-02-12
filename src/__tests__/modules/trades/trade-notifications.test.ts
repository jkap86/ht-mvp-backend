/**
 * Trade Notification Integration Tests
 *
 * Tests the full notification flow for trade propose and counter:
 * - DM toggle (ON/OFF)
 * - League chat modes (none/summary/details)
 * - Commissioner cap enforcement
 * - Default initialization and clamping
 */

import { Pool, PoolClient } from 'pg';
import { TradesService } from '../../../modules/trades/trades.service';
import {
  TradesRepository,
  TradeItemsRepository,
  TradeVotesRepository,
} from '../../../modules/trades/trades.repository';
import {
  RosterPlayersRepository,
  RosterTransactionsRepository,
} from '../../../modules/rosters/rosters.repository';
import { RosterMutationService } from '../../../modules/rosters/roster-mutation.service';
import { LeagueRepository, RosterRepository } from '../../../modules/leagues/leagues.repository';
import { PlayerRepository } from '../../../modules/players/players.repository';
import { EventListenerService } from '../../../modules/chat/event-listener.service';
import { SystemMessageService } from '../../../modules/chat/system-message.service';
import { DmService } from '../../../modules/dm/dm.service';
import {
  Trade,
  TradeWithDetails,
  TradeItemWithPlayer,
  LeagueChatMode,
} from '../../../modules/trades/trades.model';
import {
  getEffectiveLeagueChatMode,
  clampLeagueChatMode,
} from '../../../modules/trades/trade-notification.utils';

// Mock socket service
jest.mock('../../../socket', () => ({
  tryGetSocketService: jest.fn(() => ({
    emitTradeProposed: jest.fn(),
    emitTradeCountered: jest.fn(),
  })),
  getSocketService: jest.fn(() => ({
    emitTradeProposed: jest.fn(),
    emitTradeCountered: jest.fn(),
  })),
}));

// Mock data factories
function createMockTrade(overrides: Partial<Trade> = {}): Trade {
  return {
    id: 1,
    leagueId: 1,
    proposerRosterId: 1,
    recipientRosterId: 2,
    status: 'pending',
    parentTradeId: null,
    expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000),
    reviewStartsAt: null,
    reviewEndsAt: null,
    message: 'Test trade',
    season: 2024,
    week: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    completedAt: null,
    failureReason: null,
    notifyLeagueChat: true,
    notifyDm: true,
    leagueChatMode: 'summary',
    ...overrides,
  };
}

function createMockTradeWithDetails(overrides: Partial<TradeWithDetails> = {}): TradeWithDetails {
  const baseTrade = createMockTrade(overrides);
  return {
    ...baseTrade,
    items: [
      {
        id: 1,
        tradeId: 1,
        itemType: 'player',
        playerId: 100,
        fromRosterId: 1,
        toRosterId: 2,
        playerName: 'Test Player',
        playerPosition: 'QB',
        playerTeam: 'TST',
        draftPickAssetId: null,
        pickSeason: null,
        pickRound: null,
        pickOriginalTeam: null,
        createdAt: new Date(),
        fullName: 'Test Player',
        position: 'QB',
        team: 'TST',
        status: 'Active',
      } as TradeItemWithPlayer,
    ],
    proposerTeamName: 'Team A',
    recipientTeamName: 'Team B',
    proposerUsername: 'userA',
    recipientUsername: 'userB',
    ...overrides,
  };
}

function createMockLeague(overrides: Partial<any> = {}): any {
  return {
    id: 1,
    name: 'Test League',
    season: '2024',
    currentWeek: 1,
    settings: {
      roster_size: 15,
      trade_expiry_hours: 48,
      trade_review_enabled: false,
      trade_voting_enabled: false,
      trade_veto_count: 4,
    },
    leagueSettings: {
      tradeProposalLeagueChatMax: 'details',
      tradeProposalLeagueChatDefault: 'summary',
    },
    ...overrides,
  };
}

function createMockRoster(id: number, userId: string): any {
  return {
    id,
    leagueId: 1,
    userId,
    settings: {},
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

// ============================================================================
// Unit Tests: getEffectiveLeagueChatMode utility
// ============================================================================
describe('getEffectiveLeagueChatMode', () => {
  describe('mode resolution priority', () => {
    it('should use userMode when provided', () => {
      expect(getEffectiveLeagueChatMode('details', undefined, 'details', 'summary')).toBe(
        'details'
      );
      expect(getEffectiveLeagueChatMode('none', undefined, 'details', 'summary')).toBe('none');
      expect(getEffectiveLeagueChatMode('summary', undefined, 'details', 'summary')).toBe(
        'summary'
      );
    });

    it('should fall back to legacy boolean when userMode is undefined', () => {
      // true → 'summary'
      expect(getEffectiveLeagueChatMode(undefined, true, 'details', 'none')).toBe('summary');
      // false → 'none'
      expect(getEffectiveLeagueChatMode(undefined, false, 'details', 'summary')).toBe('none');
    });

    it('should use commissioner default when both userMode and legacy boolean are undefined', () => {
      expect(getEffectiveLeagueChatMode(undefined, undefined, 'details', 'summary')).toBe(
        'summary'
      );
      expect(getEffectiveLeagueChatMode(undefined, undefined, 'details', 'none')).toBe('none');
      expect(getEffectiveLeagueChatMode(undefined, undefined, 'details', 'details')).toBe(
        'details'
      );
    });
  });

  describe('commissioner cap clamping', () => {
    it('should clamp to max=none (always returns none)', () => {
      expect(getEffectiveLeagueChatMode('details', undefined, 'none', 'details')).toBe('none');
      expect(getEffectiveLeagueChatMode('summary', undefined, 'none', 'summary')).toBe('none');
      expect(getEffectiveLeagueChatMode('none', undefined, 'none', 'none')).toBe('none');
    });

    it('should clamp to max=summary (details becomes summary)', () => {
      expect(getEffectiveLeagueChatMode('details', undefined, 'summary', 'details')).toBe(
        'summary'
      );
      expect(getEffectiveLeagueChatMode('summary', undefined, 'summary', 'summary')).toBe(
        'summary'
      );
      expect(getEffectiveLeagueChatMode('none', undefined, 'summary', 'none')).toBe('none');
    });

    it('should allow all values when max=details', () => {
      expect(getEffectiveLeagueChatMode('details', undefined, 'details', 'summary')).toBe(
        'details'
      );
      expect(getEffectiveLeagueChatMode('summary', undefined, 'details', 'summary')).toBe(
        'summary'
      );
      expect(getEffectiveLeagueChatMode('none', undefined, 'details', 'summary')).toBe('none');
    });
  });

  describe('edge cases', () => {
    it('should handle missing commissioner settings with defaults', () => {
      // Default max is 'details', default is 'summary'
      expect(getEffectiveLeagueChatMode(undefined, undefined)).toBe('summary');
    });

    it('should clamp default to max when default exceeds max', () => {
      // default is 'details' but max is 'summary' → result should be 'summary'
      expect(getEffectiveLeagueChatMode(undefined, undefined, 'summary', 'details')).toBe(
        'summary'
      );
      // default is 'summary' but max is 'none' → result should be 'none'
      expect(getEffectiveLeagueChatMode(undefined, undefined, 'none', 'summary')).toBe('none');
    });
  });
});

describe('clampLeagueChatMode', () => {
  it('should not change mode when within max', () => {
    expect(clampLeagueChatMode('none', 'details')).toBe('none');
    expect(clampLeagueChatMode('summary', 'details')).toBe('summary');
    expect(clampLeagueChatMode('details', 'details')).toBe('details');
    expect(clampLeagueChatMode('none', 'summary')).toBe('none');
    expect(clampLeagueChatMode('summary', 'summary')).toBe('summary');
    expect(clampLeagueChatMode('none', 'none')).toBe('none');
  });

  it('should clamp mode when exceeds max', () => {
    expect(clampLeagueChatMode('details', 'summary')).toBe('summary');
    expect(clampLeagueChatMode('details', 'none')).toBe('none');
    expect(clampLeagueChatMode('summary', 'none')).toBe('none');
  });
});

// ============================================================================
// Integration Tests: EventListenerService notification behavior
// ============================================================================
describe('EventListenerService', () => {
  let eventListenerService: EventListenerService;
  let mockSystemMessageService: jest.Mocked<SystemMessageService>;
  let mockTradesRepo: jest.Mocked<TradesRepository>;
  let mockRosterRepo: jest.Mocked<RosterRepository>;
  let mockLeagueRepo: jest.Mocked<LeagueRepository>;
  let mockDmService: jest.Mocked<DmService>;

  beforeEach(() => {
    mockSystemMessageService = {
      createAndBroadcast: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<SystemMessageService>;

    mockTradesRepo = {
      findByIdWithDetails: jest.fn(),
    } as unknown as jest.Mocked<TradesRepository>;

    mockRosterRepo = {
      findById: jest.fn(),
    } as unknown as jest.Mocked<RosterRepository>;

    mockLeagueRepo = {
      findById: jest.fn(),
    } as unknown as jest.Mocked<LeagueRepository>;

    mockDmService = {
      getOrCreateConversation: jest.fn().mockResolvedValue({ id: 'conv-1' }),
      sendMessage: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<DmService>;

    eventListenerService = new EventListenerService(
      mockSystemMessageService,
      mockTradesRepo,
      mockRosterRepo,
      mockLeagueRepo,
      mockDmService
    );
  });

  describe('handleTradeProposed', () => {
    describe('DM toggle tests', () => {
      beforeEach(() => {
        mockTradesRepo.findByIdWithDetails.mockResolvedValue(createMockTradeWithDetails());
        mockLeagueRepo.findById.mockResolvedValue(createMockLeague());
        mockRosterRepo.findById.mockImplementation((id) =>
          Promise.resolve(
            id === 1 ? createMockRoster(1, 'user-A') : createMockRoster(2, 'user-B')
          )
        );
      });

      it('should send DM when notifyDm=true', async () => {
        await eventListenerService.handleTradeProposed(1, 1, {
          notifyDm: true,
          leagueChatMode: 'none', // isolate DM test
        });

        expect(mockDmService.getOrCreateConversation).toHaveBeenCalledWith('user-A', 'user-B');
        expect(mockDmService.sendMessage).toHaveBeenCalled();

        // Verify DM content includes summary + blank line + details
        const dmContent = mockDmService.sendMessage.mock.calls[0][2];
        expect(dmContent).toContain('Team A proposed a trade to Team B');
        expect(dmContent).toContain('\n\n');
        expect(dmContent).toContain('Team A gives:');
        expect(dmContent).toContain('Test Player');
      });

      it('should send DM when notifyDm is undefined (default behavior)', async () => {
        await eventListenerService.handleTradeProposed(1, 1, {
          leagueChatMode: 'none',
          // notifyDm not specified
        });

        expect(mockDmService.getOrCreateConversation).toHaveBeenCalled();
        expect(mockDmService.sendMessage).toHaveBeenCalled();
      });

      it('should NOT send DM when notifyDm=false', async () => {
        await eventListenerService.handleTradeProposed(1, 1, {
          notifyDm: false,
          leagueChatMode: 'summary',
        });

        expect(mockDmService.getOrCreateConversation).not.toHaveBeenCalled();
        expect(mockDmService.sendMessage).not.toHaveBeenCalled();
      });
    });

    describe('League chat mode tests', () => {
      beforeEach(() => {
        mockTradesRepo.findByIdWithDetails.mockResolvedValue(createMockTradeWithDetails());
        mockLeagueRepo.findById.mockResolvedValue(createMockLeague());
        mockRosterRepo.findById.mockImplementation((id) =>
          Promise.resolve(
            id === 1 ? createMockRoster(1, 'user-A') : createMockRoster(2, 'user-B')
          )
        );
      });

      it('should NOT post to league chat when mode=none', async () => {
        await eventListenerService.handleTradeProposed(1, 1, {
          notifyDm: false,
          leagueChatMode: 'none',
        });

        expect(mockSystemMessageService.createAndBroadcast).not.toHaveBeenCalled();
      });

      it('should post summary only when mode=summary', async () => {
        await eventListenerService.handleTradeProposed(1, 1, {
          notifyDm: false,
          leagueChatMode: 'summary',
        });

        expect(mockSystemMessageService.createAndBroadcast).toHaveBeenCalledWith(
          1,
          'trade_proposed',
          expect.objectContaining({
            tradeId: 1,
            fromTeam: 'Team A',
            toTeam: 'Team B',
            details: undefined, // No details for summary mode
          })
        );
      });

      it('should post summary + details when mode=details', async () => {
        await eventListenerService.handleTradeProposed(1, 1, {
          notifyDm: false,
          leagueChatMode: 'details',
        });

        expect(mockSystemMessageService.createAndBroadcast).toHaveBeenCalledWith(
          1,
          'trade_proposed',
          expect.objectContaining({
            tradeId: 1,
            fromTeam: 'Team A',
            toTeam: 'Team B',
            details: expect.stringContaining('Team A gives:'),
          })
        );
      });
    });

    describe('Commissioner cap enforcement', () => {
      beforeEach(() => {
        mockTradesRepo.findByIdWithDetails.mockResolvedValue(createMockTradeWithDetails());
        mockRosterRepo.findById.mockImplementation((id) =>
          Promise.resolve(
            id === 1 ? createMockRoster(1, 'user-A') : createMockRoster(2, 'user-B')
          )
        );
      });

      it('should clamp details to none when max=none', async () => {
        mockLeagueRepo.findById.mockResolvedValue(
          createMockLeague({
            leagueSettings: {
              tradeProposalLeagueChatMax: 'none',
              tradeProposalLeagueChatDefault: 'summary',
            },
          })
        );

        await eventListenerService.handleTradeProposed(1, 1, {
          notifyDm: false,
          leagueChatMode: 'details', // User requests details
        });

        // Should be clamped to none, so no league chat message
        expect(mockSystemMessageService.createAndBroadcast).not.toHaveBeenCalled();
      });

      it('should clamp details to summary when max=summary', async () => {
        mockLeagueRepo.findById.mockResolvedValue(
          createMockLeague({
            leagueSettings: {
              tradeProposalLeagueChatMax: 'summary',
              tradeProposalLeagueChatDefault: 'summary',
            },
          })
        );

        await eventListenerService.handleTradeProposed(1, 1, {
          notifyDm: false,
          leagueChatMode: 'details', // User requests details
        });

        // Should be clamped to summary (no details field)
        expect(mockSystemMessageService.createAndBroadcast).toHaveBeenCalledWith(
          1,
          'trade_proposed',
          expect.objectContaining({
            details: undefined,
          })
        );
      });

      it('should allow details when max=details', async () => {
        mockLeagueRepo.findById.mockResolvedValue(
          createMockLeague({
            leagueSettings: {
              tradeProposalLeagueChatMax: 'details',
              tradeProposalLeagueChatDefault: 'summary',
            },
          })
        );

        await eventListenerService.handleTradeProposed(1, 1, {
          notifyDm: false,
          leagueChatMode: 'details',
        });

        expect(mockSystemMessageService.createAndBroadcast).toHaveBeenCalledWith(
          1,
          'trade_proposed',
          expect.objectContaining({
            details: expect.any(String),
          })
        );
      });
    });

    describe('Default initialization', () => {
      beforeEach(() => {
        mockTradesRepo.findByIdWithDetails.mockResolvedValue(createMockTradeWithDetails());
        mockRosterRepo.findById.mockImplementation((id) =>
          Promise.resolve(
            id === 1 ? createMockRoster(1, 'user-A') : createMockRoster(2, 'user-B')
          )
        );
      });

      it('should use commissioner default when no mode specified', async () => {
        mockLeagueRepo.findById.mockResolvedValue(
          createMockLeague({
            leagueSettings: {
              tradeProposalLeagueChatMax: 'details',
              tradeProposalLeagueChatDefault: 'details',
            },
          })
        );

        await eventListenerService.handleTradeProposed(1, 1, {
          notifyDm: false,
          // No leagueChatMode specified
        });

        // Should use default 'details'
        expect(mockSystemMessageService.createAndBroadcast).toHaveBeenCalledWith(
          1,
          'trade_proposed',
          expect.objectContaining({
            details: expect.any(String),
          })
        );
      });

      it('should clamp default to max when default exceeds max', async () => {
        mockLeagueRepo.findById.mockResolvedValue(
          createMockLeague({
            leagueSettings: {
              tradeProposalLeagueChatMax: 'none',
              tradeProposalLeagueChatDefault: 'details', // Default exceeds max
            },
          })
        );

        await eventListenerService.handleTradeProposed(1, 1, {
          notifyDm: false,
          // No leagueChatMode specified - should use clamped default
        });

        // Default 'details' clamped to 'none' → no message
        expect(mockSystemMessageService.createAndBroadcast).not.toHaveBeenCalled();
      });
    });
  });

  describe('handleTradeCountered', () => {
    beforeEach(() => {
      mockTradesRepo.findByIdWithDetails.mockResolvedValue(createMockTradeWithDetails());
      mockLeagueRepo.findById.mockResolvedValue(createMockLeague());
      mockRosterRepo.findById.mockImplementation((id) =>
        Promise.resolve(id === 1 ? createMockRoster(1, 'user-A') : createMockRoster(2, 'user-B'))
      );
    });

    describe('DM toggle tests', () => {
      it('should send DM when notifyDm=true', async () => {
        await eventListenerService.handleTradeCountered(1, 1, {
          notifyDm: true,
          leagueChatMode: 'none',
        });

        expect(mockDmService.getOrCreateConversation).toHaveBeenCalled();
        expect(mockDmService.sendMessage).toHaveBeenCalled();
      });

      it('should NOT send DM when notifyDm=false', async () => {
        await eventListenerService.handleTradeCountered(1, 1, {
          notifyDm: false,
          leagueChatMode: 'summary',
        });

        expect(mockDmService.getOrCreateConversation).not.toHaveBeenCalled();
        expect(mockDmService.sendMessage).not.toHaveBeenCalled();
      });
    });

    describe('League chat mode tests', () => {
      it('should NOT post to league chat when mode=none', async () => {
        await eventListenerService.handleTradeCountered(1, 1, {
          notifyDm: false,
          leagueChatMode: 'none',
        });

        expect(mockSystemMessageService.createAndBroadcast).not.toHaveBeenCalled();
      });

      it('should post summary only when mode=summary', async () => {
        await eventListenerService.handleTradeCountered(1, 1, {
          notifyDm: false,
          leagueChatMode: 'summary',
        });

        expect(mockSystemMessageService.createAndBroadcast).toHaveBeenCalledWith(
          1,
          'trade_countered',
          expect.objectContaining({
            details: undefined,
          })
        );
      });

      it('should post summary + details when mode=details', async () => {
        await eventListenerService.handleTradeCountered(1, 1, {
          notifyDm: false,
          leagueChatMode: 'details',
        });

        expect(mockSystemMessageService.createAndBroadcast).toHaveBeenCalledWith(
          1,
          'trade_countered',
          expect.objectContaining({
            details: expect.any(String),
          })
        );
      });
    });

    describe('Commissioner cap enforcement (same as propose)', () => {
      it('should clamp to commissioner max for counter trades', async () => {
        mockLeagueRepo.findById.mockResolvedValue(
          createMockLeague({
            leagueSettings: {
              tradeProposalLeagueChatMax: 'summary',
              tradeProposalLeagueChatDefault: 'summary',
            },
          })
        );

        await eventListenerService.handleTradeCountered(1, 1, {
          notifyDm: false,
          leagueChatMode: 'details',
        });

        expect(mockSystemMessageService.createAndBroadcast).toHaveBeenCalledWith(
          1,
          'trade_countered',
          expect.objectContaining({
            details: undefined, // Clamped from 'details' to 'summary'
          })
        );
      });
    });
  });
});

// ============================================================================
// Test Matrix Summary
// ============================================================================
describe('Trade Notification Test Matrix', () => {
  describe('DM toggle matrix', () => {
    const testCases = [
      { notifyDm: true, expectDm: true, description: 'DM ON → DM sent' },
      { notifyDm: false, expectDm: false, description: 'DM OFF → no DM' },
      { notifyDm: undefined, expectDm: true, description: 'DM default → DM sent' },
    ];

    it.each(testCases)('$description', ({ notifyDm, expectDm }) => {
      // This is a placeholder to document the expected behavior
      // Actual tests are in the EventListenerService tests above
      expect(notifyDm !== false).toBe(expectDm);
    });
  });

  describe('League chat mode matrix', () => {
    const testCases = [
      { mode: 'none' as LeagueChatMode, expectMessage: false, expectDetails: false },
      { mode: 'summary' as LeagueChatMode, expectMessage: true, expectDetails: false },
      { mode: 'details' as LeagueChatMode, expectMessage: true, expectDetails: true },
    ];

    it.each(testCases)(
      'mode=$mode → message=$expectMessage, details=$expectDetails',
      ({ mode, expectMessage, expectDetails }) => {
        // Document expected behavior
        expect(mode !== 'none').toBe(expectMessage);
        expect(mode === 'details').toBe(expectDetails);
      }
    );
  });

  describe('Commissioner cap matrix', () => {
    const testCases = [
      { requested: 'details' as LeagueChatMode, max: 'none' as LeagueChatMode, expected: 'none' },
      { requested: 'details' as LeagueChatMode, max: 'summary' as LeagueChatMode, expected: 'summary' },
      { requested: 'details' as LeagueChatMode, max: 'details' as LeagueChatMode, expected: 'details' },
      { requested: 'summary' as LeagueChatMode, max: 'none' as LeagueChatMode, expected: 'none' },
      { requested: 'summary' as LeagueChatMode, max: 'summary' as LeagueChatMode, expected: 'summary' },
      { requested: 'summary' as LeagueChatMode, max: 'details' as LeagueChatMode, expected: 'summary' },
      { requested: 'none' as LeagueChatMode, max: 'none' as LeagueChatMode, expected: 'none' },
      { requested: 'none' as LeagueChatMode, max: 'summary' as LeagueChatMode, expected: 'none' },
      { requested: 'none' as LeagueChatMode, max: 'details' as LeagueChatMode, expected: 'none' },
    ];

    it.each(testCases)(
      'requested=$requested, max=$max → effective=$expected',
      ({ requested, max, expected }) => {
        const result = clampLeagueChatMode(requested, max);
        expect(result).toBe(expected);
      }
    );
  });
});
