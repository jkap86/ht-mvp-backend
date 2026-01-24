/**
 * Roster player management models
 */

export type AcquiredType = 'draft' | 'free_agent' | 'trade' | 'waiver';
export type TransactionType = 'add' | 'drop' | 'trade';

export interface RosterPlayer {
  id: number;
  rosterId: number;
  playerId: number;
  acquiredType: AcquiredType;
  acquiredAt: Date;
}

export function rosterPlayerFromDatabase(row: any): RosterPlayer {
  return {
    id: row.id,
    rosterId: row.roster_id,
    playerId: row.player_id,
    acquiredType: row.acquired_type,
    acquiredAt: row.acquired_at,
  };
}

export function rosterPlayerToResponse(rosterPlayer: RosterPlayer) {
  return {
    id: rosterPlayer.id,
    roster_id: rosterPlayer.rosterId,
    player_id: rosterPlayer.playerId,
    acquired_type: rosterPlayer.acquiredType,
    acquired_at: rosterPlayer.acquiredAt,
  };
}

export interface RosterTransaction {
  id: number;
  leagueId: number;
  rosterId: number;
  playerId: number;
  transactionType: TransactionType;
  relatedTransactionId: number | null;
  season: number;
  week: number;
  createdAt: Date;
}

export function rosterTransactionFromDatabase(row: any): RosterTransaction {
  return {
    id: row.id,
    leagueId: row.league_id,
    rosterId: row.roster_id,
    playerId: row.player_id,
    transactionType: row.transaction_type,
    relatedTransactionId: row.related_transaction_id,
    season: row.season,
    week: row.week,
    createdAt: row.created_at,
  };
}

export function rosterTransactionToResponse(transaction: RosterTransaction) {
  return {
    id: transaction.id,
    league_id: transaction.leagueId,
    roster_id: transaction.rosterId,
    player_id: transaction.playerId,
    transaction_type: transaction.transactionType,
    related_transaction_id: transaction.relatedTransactionId,
    season: transaction.season,
    week: transaction.week,
    created_at: transaction.createdAt,
  };
}

// Extended roster player with player details
export interface RosterPlayerWithDetails extends RosterPlayer {
  fullName: string;
  position: string | null;
  team: string | null;
  status: string | null;
  injuryStatus: string | null;
}

export function rosterPlayerWithDetailsToResponse(rp: RosterPlayerWithDetails) {
  return {
    ...rosterPlayerToResponse(rp),
    full_name: rp.fullName,
    position: rp.position,
    team: rp.team,
    status: rp.status,
    injury_status: rp.injuryStatus,
  };
}
