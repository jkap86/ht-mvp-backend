import { Pool } from 'pg';
import type { AuthorizationService } from '../auth/authorization.service';
import type { DraftRepository } from '../drafts/drafts.repository';
import type { DraftChessClockRepository } from '../drafts/repositories/draft-chess-clock.repository';
import type { DraftStateService } from '../drafts/draft-state.service';
import type { WaiverPriorityRepository } from '../waivers/waiver-priority.repository';
import type { FaabBudgetRepository } from '../waivers/faab-budget.repository';
import type { TradesRepository } from '../trades/trades.repository';
import type { LeagueRepository, RosterRepository } from '../leagues/leagues.repository';
import type { DuesService } from '../dues/dues.service';
import type { EventListenerService } from '../chat/event-listener.service';
import { runWithLock, LockDomain } from '../../shared/transaction-runner';
import { EventTypes, tryGetEventBus } from '../../shared/events';
import { adminCancelTrade } from '../trades/use-cases/admin-cancel-trade.use-case';
import {
  NotFoundException,
  ValidationException,
} from '../../utils/exceptions';
import type { DuesPaymentWithRoster } from '../dues/dues.model';

export class CommissionerToolsService {
  constructor(
    private readonly pool: Pool,
    private readonly authorizationService: AuthorizationService,
    private readonly draftRepo: DraftRepository,
    private readonly chessClockRepo: DraftChessClockRepository,
    private readonly draftStateService: DraftStateService,
    private readonly waiverPriorityRepo: WaiverPriorityRepository,
    private readonly faabBudgetRepo: FaabBudgetRepository,
    private readonly tradesRepo: TradesRepository,
    private readonly leagueRepo: LeagueRepository,
    private readonly rosterRepo: RosterRepository,
    private readonly duesService: DuesService,
    private readonly eventListenerService?: EventListenerService
  ) {}

  // ── Draft: Adjust Chess Clock ──────────────────────────────────

  async adjustChessClock(
    leagueId: number,
    draftId: number,
    rosterId: number,
    deltaSeconds: number,
    userId: string
  ): Promise<Record<number, number>> {
    await this.authorizationService.ensureCommissioner(leagueId, userId);

    const draft = await this.draftRepo.findById(draftId);
    if (!draft || draft.leagueId !== leagueId) {
      throw new NotFoundException('Draft not found in this league');
    }

    let clockMap: Record<number, number> = {};

    await runWithLock(this.pool, LockDomain.DRAFT, draftId, async (client) => {
      if (deltaSeconds > 0) {
        await this.chessClockRepo.restoreTimeWithClient(client, draftId, rosterId, deltaSeconds);
      } else {
        await this.chessClockRepo.deductTimeWithClient(client, draftId, rosterId, Math.abs(deltaSeconds));
      }
      clockMap = await this.chessClockRepo.getClockMapWithClient(client, draftId);
    });

    const eventBus = tryGetEventBus();
    eventBus?.publish({
      type: EventTypes.DRAFT_CHESS_CLOCK_UPDATED,
      leagueId,
      payload: { draftId, chessClocks: clockMap },
    });

    return clockMap;
  }

  // ── Draft: Force Autopick ──────────────────────────────────────

  async forceAutopick(
    leagueId: number,
    draftId: number,
    userId: string
  ): Promise<void> {
    await this.authorizationService.ensureCommissioner(leagueId, userId);

    const draft = await this.draftRepo.findById(draftId);
    if (!draft || draft.leagueId !== leagueId) {
      throw new NotFoundException('Draft not found in this league');
    }
    if (draft.status !== 'in_progress') {
      throw new ValidationException('Draft is not in progress');
    }

    // Delegate to the existing autopick mechanism
    await this.draftStateService.applyAutoPick({ draftId, reason: 'timeout' });
  }

  // ── Draft: Undo Last Pick ─────────────────────────────────────

  async undoLastPick(
    leagueId: number,
    draftId: number,
    userId: string
  ): Promise<{ draft: any; undone: any }> {
    // DraftStateService.undoPick already checks commissioner and emits events
    return this.draftStateService.undoPick(leagueId, draftId, userId);
  }

  // ── Waivers: Reset Priority ───────────────────────────────────

  async resetWaiverPriority(
    leagueId: number,
    userId: string
  ): Promise<void> {
    await this.authorizationService.ensureCommissioner(leagueId, userId);

    const league = await this.leagueRepo.findById(leagueId);
    if (!league) throw new NotFoundException('League not found');

    const season = parseInt(league.season, 10);
    const rosters = await this.rosterRepo.findByLeagueId(leagueId);
    const rosterIds = rosters.map((r: { id: number }) => r.id);

    await runWithLock(this.pool, LockDomain.WAIVER, leagueId, async (client) => {
      await this.waiverPriorityRepo.initializeForLeague(leagueId, season, rosterIds, client);
    });

    const eventBus = tryGetEventBus();
    eventBus?.publish({
      type: EventTypes.WAIVER_PRIORITY_UPDATED,
      leagueId,
      payload: { leagueId, reset: true },
    });
  }

  // ── Waivers: Set Priority ─────────────────────────────────────

  async setWaiverPriority(
    leagueId: number,
    rosterId: number,
    newPriority: number,
    userId: string
  ): Promise<void> {
    await this.authorizationService.ensureCommissioner(leagueId, userId);

    const league = await this.leagueRepo.findById(leagueId);
    if (!league) throw new NotFoundException('League not found');

    const season = parseInt(league.season, 10);

    await runWithLock(this.pool, LockDomain.WAIVER, leagueId, async (client) => {
      const current = await this.waiverPriorityRepo.getByRoster(rosterId, season, client);
      if (!current) {
        throw new NotFoundException('Waiver priority not found for this roster');
      }
      if (current.priority === newPriority) return;

      const maxPriority = await this.waiverPriorityRepo.getMaxPriority(leagueId, season, client);
      if (newPriority < 1 || newPriority > maxPriority) {
        throw new ValidationException(`Priority must be between 1 and ${maxPriority}`);
      }

      await this.waiverPriorityRepo.setPriority(leagueId, season, rosterId, newPriority, client);
    });

    const eventBus = tryGetEventBus();
    eventBus?.publish({
      type: EventTypes.WAIVER_PRIORITY_UPDATED,
      leagueId,
      payload: { leagueId, rosterId, priority: newPriority },
    });
  }

  // ── Waivers: Set FAAB Budget ──────────────────────────────────

  async setFaabBudget(
    leagueId: number,
    rosterId: number,
    setTo: number,
    userId: string
  ): Promise<void> {
    await this.authorizationService.ensureCommissioner(leagueId, userId);

    const league = await this.leagueRepo.findById(leagueId);
    if (!league) throw new NotFoundException('League not found');

    const roster = await this.rosterRepo.findById(rosterId);
    if (!roster || roster.leagueId !== leagueId) {
      throw new NotFoundException('Roster not found in this league');
    }

    const season = parseInt(league.season, 10);

    await runWithLock(this.pool, LockDomain.WAIVER, leagueId, async (client) => {
      await this.faabBudgetRepo.setBudget(rosterId, season, setTo, client);
    });

    const eventBus = tryGetEventBus();
    eventBus?.publish({
      type: EventTypes.WAIVER_BUDGET_UPDATED,
      leagueId,
      payload: { leagueId, rosterId, remainingBudget: setTo },
    });
  }

  // ── Trades: Admin Cancel ──────────────────────────────────────

  async adminCancelTrade(
    leagueId: number,
    tradeId: number,
    userId: string,
    reason?: string
  ): Promise<void> {
    await this.authorizationService.ensureCommissioner(leagueId, userId);

    await adminCancelTrade(
      {
        db: this.pool,
        tradesRepo: this.tradesRepo,
        eventListenerService: this.eventListenerService,
      },
      leagueId,
      tradeId,
      reason
    );
  }

  // ── Trades: Lock/Unlock Trading ───────────────────────────────

  async updateTradingLocked(
    leagueId: number,
    tradingLocked: boolean,
    userId: string
  ): Promise<void> {
    await this.authorizationService.ensureCommissioner(leagueId, userId);

    await this.leagueRepo.update(leagueId, {
      leagueSettings: { trading_locked: tradingLocked },
    } as any);

    const eventBus = tryGetEventBus();
    eventBus?.publish({
      type: EventTypes.LEAGUE_SETTINGS_UPDATED,
      leagueId,
      payload: { leagueId, tradingLocked },
    });
  }

  // ── Dues: Export CSV ──────────────────────────────────────────

  async exportDuesCsv(
    leagueId: number,
    userId: string,
    leagueSeasonId?: number
  ): Promise<string> {
    await this.authorizationService.ensureCommissioner(leagueId, userId);

    const payments: DuesPaymentWithRoster[] = await this.duesService.getPaymentStatuses(
      leagueId,
      userId,
      leagueSeasonId
    );

    const escapeCsv = (val: string): string => {
      if (val.includes(',') || val.includes('"') || val.includes('\n')) {
        return `"${val.replace(/"/g, '""')}"`;
      }
      return val;
    };

    const header = 'Team Name,Username,Paid,Paid At,Notes';
    const rows = payments.map((p) =>
      [
        escapeCsv(p.teamName),
        escapeCsv(p.username),
        p.isPaid ? 'Yes' : 'No',
        p.paidAt ? p.paidAt.toISOString() : '',
        escapeCsv(p.notes || ''),
      ].join(',')
    );

    return header + '\n' + rows.join('\n');
  }
}
