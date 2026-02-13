/**
 * League dues domain models
 */

export interface PayoutStructure {
  [place: string]: number; // e.g., {"1st": 70, "2nd": 20, "3rd": 10}
}

export interface LeagueDues {
  id: number;
  leagueId: number;
  leagueSeasonId: number;
  buyInAmount: number;
  payoutStructure: PayoutStructure;
  currency: string;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface DuesPayment {
  id: number;
  leagueId: number;
  leagueSeasonId: number;
  rosterId: number;
  isPaid: boolean;
  paidAt: Date | null;
  markedByUserId: string | null;
  notes: string | null;
  createdAt: Date | null;
  updatedAt: Date | null;
}

export interface DuesPaymentWithRoster extends DuesPayment {
  teamName: string;
  username: string;
}

export function leagueDuesFromDatabase(row: any): LeagueDues {
  return {
    id: row.id,
    leagueId: row.league_id,
    leagueSeasonId: row.league_season_id,
    buyInAmount: parseFloat(row.buy_in_amount) || 0,
    payoutStructure: row.payout_structure || {},
    currency: row.currency || 'USD',
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function duesPaymentFromDatabase(row: any): DuesPayment {
  return {
    id: row.id,
    leagueId: row.league_id,
    leagueSeasonId: row.league_season_id,
    rosterId: row.roster_id,
    isPaid: row.is_paid,
    paidAt: row.paid_at,
    markedByUserId: row.marked_by_user_id,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function duesPaymentWithRosterFromDatabase(row: any): DuesPaymentWithRoster {
  return {
    ...duesPaymentFromDatabase(row),
    teamName: row.team_name,
    username: row.username,
  };
}

export function leagueDuesToResponse(dues: LeagueDues) {
  return {
    id: dues.id,
    league_id: dues.leagueId,
    league_season_id: dues.leagueSeasonId,
    buy_in_amount: dues.buyInAmount,
    payout_structure: dues.payoutStructure,
    currency: dues.currency,
    notes: dues.notes,
    created_at: dues.createdAt,
    updated_at: dues.updatedAt,
  };
}

export function duesPaymentToResponse(payment: DuesPayment) {
  return {
    id: payment.id,
    league_id: payment.leagueId,
    league_season_id: payment.leagueSeasonId,
    roster_id: payment.rosterId,
    is_paid: payment.isPaid,
    paid_at: payment.paidAt,
    marked_by_user_id: payment.markedByUserId,
    notes: payment.notes,
    created_at: payment.createdAt,
    updated_at: payment.updatedAt,
  };
}

export function duesPaymentWithRosterToResponse(payment: DuesPaymentWithRoster) {
  return {
    ...duesPaymentToResponse(payment),
    team_name: payment.teamName,
    username: payment.username,
  };
}
