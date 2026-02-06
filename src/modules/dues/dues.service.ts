import { DuesRepository } from './dues.repository';
import { LeagueRepository, RosterRepository } from '../leagues/leagues.repository';
import {
  LeagueDues,
  DuesPayment,
  DuesPaymentWithRoster,
  PayoutStructure,
} from './dues.model';
import {
  NotFoundException,
  ForbiddenException,
  ValidationException,
} from '../../utils/exceptions';
import { SystemMessageService } from '../chat/system-message.service';

export interface DuesConfigInput {
  buyInAmount: number;
  payoutStructure?: PayoutStructure;
  currency?: string;
  notes?: string | null;
}

export interface DuesOverview {
  config: LeagueDues | null;
  payments: DuesPaymentWithRoster[];
  summary: {
    paidCount: number;
    totalCount: number;
    totalPot: number;
    amountCollected: number;
  };
  payouts: { place: string; amount: number }[];
}

export class DuesService {
  constructor(
    private readonly duesRepo: DuesRepository,
    private readonly leagueRepo: LeagueRepository,
    private readonly rosterRepo: RosterRepository,
    private readonly systemMessageService: SystemMessageService
  ) {}

  /**
   * Get dues configuration for a league
   */
  async getDuesConfig(leagueId: number): Promise<LeagueDues | null> {
    return this.duesRepo.getDuesConfig(leagueId);
  }

  /**
   * Get full dues overview including payments and summary
   */
  async getDuesOverview(leagueId: number, userId: string): Promise<DuesOverview> {
    // Verify user is a league member
    const isMember = await this.leagueRepo.isUserMember(leagueId, userId);
    if (!isMember) {
      throw new ForbiddenException('Only league members can view dues information');
    }

    const config = await this.duesRepo.getDuesConfig(leagueId);
    const payments = await this.duesRepo.getPaymentStatuses(leagueId);
    const summary = await this.duesRepo.getPaymentSummary(leagueId);

    const buyInAmount = config?.buyInAmount || 0;
    const totalPot = buyInAmount * summary.totalCount;
    const amountCollected = buyInAmount * summary.paidCount;

    // Calculate payouts based on payout structure
    const payouts: { place: string; amount: number }[] = [];
    if (config?.payoutStructure) {
      for (const [place, percentage] of Object.entries(config.payoutStructure)) {
        payouts.push({
          place,
          amount: Math.round((totalPot * percentage) / 100 * 100) / 100,
        });
      }
    }

    return {
      config,
      payments,
      summary: {
        ...summary,
        totalPot,
        amountCollected,
      },
      payouts,
    };
  }

  /**
   * Create or update dues configuration (commissioner only)
   */
  async upsertDuesConfig(
    leagueId: number,
    userId: string,
    input: DuesConfigInput
  ): Promise<LeagueDues> {
    // Verify user is commissioner
    const isCommissioner = await this.leagueRepo.isCommissioner(leagueId, userId);
    if (!isCommissioner) {
      throw new ForbiddenException('Only the commissioner can manage dues configuration');
    }

    // Validate payout structure
    if (input.payoutStructure) {
      const values = Object.values(input.payoutStructure);

      if (values.some((v) => typeof v !== 'number' || !Number.isFinite(v) || v < 0)) {
        throw new ValidationException('Payout percentages must be non-negative numbers');
      }

      const total = values.reduce((sum, val) => sum + val, 0);
      if (total > 100) {
        throw new ValidationException('Payout percentages cannot exceed 100%');
      }
    }

    return this.duesRepo.upsertDuesConfig({
      leagueId,
      buyInAmount: input.buyInAmount,
      payoutStructure: input.payoutStructure,
      currency: input.currency,
      notes: input.notes,
    });
  }

  /**
   * Delete dues configuration (commissioner only)
   */
  async deleteDuesConfig(leagueId: number, userId: string): Promise<void> {
    // Verify user is commissioner
    const isCommissioner = await this.leagueRepo.isCommissioner(leagueId, userId);
    if (!isCommissioner) {
      throw new ForbiddenException('Only the commissioner can delete dues configuration');
    }

    const deleted = await this.duesRepo.deleteDuesConfig(leagueId);
    if (!deleted) {
      throw new NotFoundException('Dues configuration not found');
    }
  }

  /**
   * Get all payment statuses for a league
   */
  async getPaymentStatuses(leagueId: number, userId: string): Promise<DuesPaymentWithRoster[]> {
    // Verify user is a league member
    const isMember = await this.leagueRepo.isUserMember(leagueId, userId);
    if (!isMember) {
      throw new ForbiddenException('Only league members can view payment statuses');
    }

    return this.duesRepo.getPaymentStatuses(leagueId);
  }

  /**
   * Mark payment status for a roster (commissioner only)
   */
  async markPaymentStatus(
    leagueId: number,
    rosterId: number,
    userId: string,
    isPaid: boolean,
    notes?: string | null
  ): Promise<DuesPayment> {
    // Verify user is commissioner
    const isCommissioner = await this.leagueRepo.isCommissioner(leagueId, userId);
    if (!isCommissioner) {
      throw new ForbiddenException('Only the commissioner can mark payment status');
    }

    // Verify dues config exists
    const config = await this.duesRepo.getDuesConfig(leagueId);
    if (!config) {
      throw new NotFoundException('Dues tracking is not enabled for this league');
    }

    // Verify roster exists and belongs to this league
    const roster = await this.rosterRepo.findById(rosterId);
    if (!roster || roster.leagueId !== leagueId) {
      throw new NotFoundException('Roster not found in this league');
    }

    const payment = await this.duesRepo.markPaymentStatus({
      leagueId,
      rosterId,
      isPaid,
      markedByUserId: userId,
      notes,
    });

    // Get team name and emit system message (fire-and-forget)
    const teamName = await this.rosterRepo.getTeamName(rosterId);
    this.systemMessageService
      .createAndBroadcast(leagueId, isPaid ? 'dues_paid' : 'dues_unpaid', {
        teamName: teamName || 'Unknown Team',
      })
      .catch((err) => console.error('Failed to emit dues system message:', err));

    return payment;
  }
}
