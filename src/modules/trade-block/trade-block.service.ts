import { Pool } from 'pg';
import { TradeBlockRepository } from './trade-block.repository';
import { TradeBlockItemWithDetails } from './trade-block.model';
import type { RosterRepository } from '../rosters/roster.repository';
import type { RosterPlayersRepository } from '../rosters/rosters.repository';
import { runWithLock, LockDomain } from '../../shared/transaction-runner';
import { tryGetEventBus } from '../../shared/events';
import { EventTypes } from '../../shared/events/domain-event-bus';
import { ValidationException, NotFoundException, ForbiddenException } from '../../utils/exceptions';

export class TradeBlockService {
  constructor(
    private readonly pool: Pool,
    private readonly tradeBlockRepo: TradeBlockRepository,
    private readonly rosterRepo: RosterRepository,
    private readonly rosterPlayersRepo: RosterPlayersRepository
  ) {}

  async getByLeague(leagueId: number, userId: string): Promise<TradeBlockItemWithDetails[]> {
    const roster = await this.rosterRepo.findByLeagueAndUser(leagueId, userId);
    if (!roster) {
      throw new ForbiddenException('You are not a member of this league');
    }
    return this.tradeBlockRepo.getByLeague(leagueId);
  }

  async addToTradeBlock(
    leagueId: number,
    userId: string,
    playerId: number,
    note?: string
  ): Promise<TradeBlockItemWithDetails> {
    const roster = await this.rosterRepo.findByLeagueAndUser(leagueId, userId);
    if (!roster) {
      throw new ForbiddenException('You are not a member of this league');
    }

    const item = await runWithLock(this.pool, LockDomain.ROSTER, roster.id, async (client) => {
      // Verify player is on caller's roster
      const rosterPlayer = await this.rosterPlayersRepo.findByRosterAndPlayer(roster.id, playerId, client);
      if (!rosterPlayer) {
        throw new ValidationException('Player is not on your roster');
      }

      const added = await this.tradeBlockRepo.add(client, leagueId, roster.id, playerId, note ?? null);

      const eventBus = tryGetEventBus();
      eventBus?.publish({
        type: EventTypes.TRADE_BLOCK_UPDATED,
        leagueId,
        payload: { leagueId, rosterId: roster.id, action: 'added', playerId },
      });

      return added;
    });

    return item;
  }

  async removeFromTradeBlock(leagueId: number, userId: string, playerId: number): Promise<void> {
    const roster = await this.rosterRepo.findByLeagueAndUser(leagueId, userId);
    if (!roster) {
      throw new ForbiddenException('You are not a member of this league');
    }

    await runWithLock(this.pool, LockDomain.ROSTER, roster.id, async (client) => {
      const removed = await this.tradeBlockRepo.remove(client, leagueId, roster.id, playerId);
      if (!removed) {
        throw new NotFoundException('Player is not on your trade block');
      }

      const eventBus = tryGetEventBus();
      eventBus?.publish({
        type: EventTypes.TRADE_BLOCK_UPDATED,
        leagueId,
        payload: { leagueId, rosterId: roster.id, action: 'removed', playerId },
      });
    });
  }
}
