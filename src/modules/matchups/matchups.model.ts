/**
 * Matchups and standings models
 */

export interface Matchup {
  id: number;
  leagueId: number;
  season: number;
  week: number;
  roster1Id: number;
  roster2Id: number;
  roster1Points: number | null;
  roster2Points: number | null;
  isPlayoff: boolean;
  isFinal: boolean;
  createdAt: Date;
}

export function matchupFromDatabase(row: any): Matchup {
  return {
    id: row.id,
    leagueId: row.league_id,
    season: row.season,
    week: row.week,
    roster1Id: row.roster1_id,
    roster2Id: row.roster2_id,
    roster1Points: row.roster1_points ? parseFloat(row.roster1_points) : null,
    roster2Points: row.roster2_points ? parseFloat(row.roster2_points) : null,
    isPlayoff: row.is_playoff,
    isFinal: row.is_final,
    createdAt: row.created_at,
  };
}

export function matchupToResponse(matchup: Matchup) {
  return {
    id: matchup.id,
    league_id: matchup.leagueId,
    season: matchup.season,
    week: matchup.week,
    roster1_id: matchup.roster1Id,
    roster2_id: matchup.roster2Id,
    roster1_points: matchup.roster1Points,
    roster2_points: matchup.roster2Points,
    is_playoff: matchup.isPlayoff,
    is_final: matchup.isFinal,
    created_at: matchup.createdAt,
  };
}

export interface MatchupDetails extends Matchup {
  roster1TeamName: string;
  roster2TeamName: string;
  // Records are optional - computed from standings when needed
  roster1Record?: { wins: number; losses: number; ties: number };
  roster2Record?: { wins: number; losses: number; ties: number };
}

export function matchupDetailsToResponse(matchup: MatchupDetails) {
  return {
    ...matchupToResponse(matchup),
    roster1_team_name: matchup.roster1TeamName,
    roster2_team_name: matchup.roster2TeamName,
    // Only include records if they exist (computed from standings)
    ...(matchup.roster1Record && { roster1_record: matchup.roster1Record }),
    ...(matchup.roster2Record && { roster2_record: matchup.roster2Record }),
  };
}

export interface Standing {
  rosterId: number;
  teamName: string;
  userId: string | null;
  wins: number;
  losses: number;
  ties: number;
  pointsFor: number;
  pointsAgainst: number;
  streak: string; // "W3", "L1", "T1"
  rank: number;
}

export function standingToResponse(standing: Standing) {
  return {
    roster_id: standing.rosterId,
    team_name: standing.teamName,
    user_id: standing.userId,
    wins: standing.wins,
    losses: standing.losses,
    ties: standing.ties,
    points_for: standing.pointsFor,
    points_against: standing.pointsAgainst,
    streak: standing.streak,
    rank: standing.rank,
  };
}

/**
 * Player performance in a matchup lineup
 */
export interface MatchupPlayerPerformance {
  playerId: number;
  fullName: string;
  position: string;
  team: string | null;
  slot: string;
  points: number;
  isStarter: boolean;
}

/**
 * Team lineup within a matchup
 */
export interface MatchupTeamLineup {
  rosterId: number;
  teamName: string;
  totalPoints: number;
  players: MatchupPlayerPerformance[];
}

/**
 * Full matchup detail with both team lineups
 */
export interface MatchupWithLineups extends MatchupDetails {
  team1: MatchupTeamLineup;
  team2: MatchupTeamLineup;
}

export function matchupWithLineupsToResponse(matchup: MatchupWithLineups) {
  return {
    ...matchupDetailsToResponse(matchup),
    team1: {
      roster_id: matchup.team1.rosterId,
      team_name: matchup.team1.teamName,
      total_points: matchup.team1.totalPoints,
      players: matchup.team1.players.map((p) => ({
        player_id: p.playerId,
        full_name: p.fullName,
        position: p.position,
        team: p.team,
        slot: p.slot,
        points: p.points,
        is_starter: p.isStarter,
      })),
    },
    team2: {
      roster_id: matchup.team2.rosterId,
      team_name: matchup.team2.teamName,
      total_points: matchup.team2.totalPoints,
      players: matchup.team2.players.map((p) => ({
        player_id: p.playerId,
        full_name: p.fullName,
        position: p.position,
        team: p.team,
        slot: p.slot,
        points: p.points,
        is_starter: p.isStarter,
      })),
    },
  };
}
