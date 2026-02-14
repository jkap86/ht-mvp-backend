export interface TradeBlockItem {
  id: number;
  leagueId: number;
  rosterId: number;
  playerId: number;
  note: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface TradeBlockItemWithDetails extends TradeBlockItem {
  fullName: string;
  position: string;
  team: string;
  teamName: string;
  username: string;
}

export function tradeBlockItemFromDatabase(row: any): TradeBlockItem {
  return {
    id: row.id,
    leagueId: row.league_id,
    rosterId: row.roster_id,
    playerId: row.player_id,
    note: row.note || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function tradeBlockItemToResponse(item: TradeBlockItemWithDetails): Record<string, any> {
  return {
    id: item.id,
    league_id: item.leagueId,
    roster_id: item.rosterId,
    player_id: item.playerId,
    note: item.note,
    created_at: item.createdAt,
    updated_at: item.updatedAt,
    full_name: item.fullName,
    position: item.position,
    team: item.team,
    team_name: item.teamName,
    username: item.username,
  };
}
