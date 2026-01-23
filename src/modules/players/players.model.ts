export interface Player {
  id: number;
  sleeperId: string;
  firstName: string | null;
  lastName: string | null;
  fullName: string;
  fantasyPositions: string[];
  position: string | null;
  team: string | null;
  yearsExp: number | null;
  age: number | null;
  active: boolean;
  status: string | null;
  injuryStatus: string | null;
  jerseyNumber: number | null;
  createdAt: Date;
  updatedAt: Date;
}

export function playerFromDatabase(row: any): Player {
  return {
    id: row.id,
    sleeperId: row.sleeper_id,
    firstName: row.first_name,
    lastName: row.last_name,
    fullName: row.full_name,
    fantasyPositions: row.fantasy_positions || [],
    position: row.position,
    team: row.team,
    yearsExp: row.years_exp,
    age: row.age,
    active: row.active,
    status: row.status,
    injuryStatus: row.injury_status,
    jerseyNumber: row.jersey_number,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function playerToResponse(player: Player) {
  return {
    id: player.id,
    sleeper_id: player.sleeperId,
    first_name: player.firstName,
    last_name: player.lastName,
    full_name: player.fullName,
    fantasy_positions: player.fantasyPositions,
    position: player.position,
    team: player.team,
    years_exp: player.yearsExp,
    age: player.age,
    active: player.active,
    status: player.status,
    injury_status: player.injuryStatus,
    jersey_number: player.jerseyNumber,
  };
}
