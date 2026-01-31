export interface Player {
  id: number;
  sleeperId: string | null;
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
  // College player fields
  cfbdId: number | null;
  college: string | null;
  height: string | null;
  weight: number | null;
  homeCity: string | null;
  homeState: string | null;
  playerType: 'nfl' | 'college';
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
    // College player fields
    cfbdId: row.cfbd_id,
    college: row.college,
    height: row.height,
    weight: row.weight,
    homeCity: row.home_city,
    homeState: row.home_state,
    playerType: row.player_type || 'nfl',
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
    // College player fields
    cfbd_id: player.cfbdId,
    college: player.college,
    height: player.height,
    weight: player.weight,
    home_city: player.homeCity,
    home_state: player.homeState,
    player_type: player.playerType,
  };
}
