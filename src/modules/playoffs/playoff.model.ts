/**
 * Playoff bracket models and types
 */

export type PlayoffStatus = 'pending' | 'active' | 'completed';
export type BracketType = 'WINNERS' | 'THIRD_PLACE' | 'CONSOLATION';
export type ConsolationType = 'NONE' | 'CONSOLATION';

export interface PlayoffSettings {
  enableThirdPlaceGame: boolean;
  consolationType: ConsolationType;
  consolationTeams: number | null;
  weeksByRound: number[] | null;
}

/**
 * Series aggregation for multi-week playoff series
 */
export interface SeriesAggregation {
  seriesId: string;
  roster1Id: number;
  roster2Id: number;
  roster1TotalPoints: number;
  roster2TotalPoints: number;
  roster1Seed: number;
  roster2Seed: number;
  gamesCompleted: number;
  seriesLength: number;
  isComplete: boolean;
}

export function playoffSettingsToResponse(settings: PlayoffSettings) {
  return {
    enable_third_place_game: settings.enableThirdPlaceGame,
    consolation_type: settings.consolationType,
    consolation_teams: settings.consolationTeams,
    weeks_by_round: settings.weeksByRound,
  };
}

export interface PlayoffBracket {
  id: number;
  leagueId: number;
  season: number;
  playoffTeams: number; // 4, 6, or 8
  totalRounds: number;
  startWeek: number;
  championshipWeek: number;
  status: PlayoffStatus;
  championRosterId: number | null;
  enableThirdPlace: boolean;
  consolationType: ConsolationType;
  consolationTeams: number | null;
  thirdPlaceRosterId: number | null;
  consolationWinnerRosterId: number | null;
  weeksByRound: number[] | null; // [1, 2, 2] = R1:1wk, R2:2wk, R3:2wk
  createdAt: Date;
  updatedAt: Date;
}

export function playoffBracketFromDatabase(row: any): PlayoffBracket {
  return {
    id: row.id,
    leagueId: row.league_id,
    season: row.season,
    playoffTeams: row.playoff_teams,
    totalRounds: row.total_rounds,
    startWeek: row.start_week,
    championshipWeek: row.championship_week,
    status: row.status as PlayoffStatus,
    championRosterId: row.champion_roster_id,
    enableThirdPlace: row.enable_third_place ?? false,
    consolationType: (row.consolation_type as ConsolationType) ?? 'NONE',
    consolationTeams: row.consolation_teams ?? null,
    thirdPlaceRosterId: row.third_place_roster_id ?? null,
    consolationWinnerRosterId: row.consolation_winner_roster_id ?? null,
    weeksByRound: row.weeks_by_round ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function playoffBracketToResponse(bracket: PlayoffBracket) {
  return {
    id: bracket.id,
    league_id: bracket.leagueId,
    season: bracket.season,
    playoff_teams: bracket.playoffTeams,
    total_rounds: bracket.totalRounds,
    start_week: bracket.startWeek,
    championship_week: bracket.championshipWeek,
    status: bracket.status,
    champion_roster_id: bracket.championRosterId,
    enable_third_place: bracket.enableThirdPlace,
    consolation_type: bracket.consolationType,
    consolation_teams: bracket.consolationTeams,
    third_place_roster_id: bracket.thirdPlaceRosterId,
    consolation_winner_roster_id: bracket.consolationWinnerRosterId,
    weeks_by_round: bracket.weeksByRound,
    created_at: bracket.createdAt,
    updated_at: bracket.updatedAt,
  };
}

export type SeedBracketType = 'WINNERS' | 'CONSOLATION';

export interface PlayoffSeed {
  id: number;
  bracketId: number;
  rosterId: number;
  seed: number;
  regularSeasonRecord: string;
  pointsFor: number;
  hasBye: boolean;
  bracketType: SeedBracketType;
  createdAt: Date;
  // Extended fields from joins
  teamName?: string;
  userId?: string;
}

export function playoffSeedFromDatabase(row: any): PlayoffSeed {
  return {
    id: row.id,
    bracketId: row.bracket_id,
    rosterId: row.roster_id,
    seed: row.seed,
    regularSeasonRecord: row.regular_season_record || '',
    pointsFor: row.points_for === null || row.points_for === undefined
      ? 0
      : parseFloat(row.points_for),
    hasBye: row.has_bye,
    bracketType: (row.bracket_type as SeedBracketType) || 'WINNERS',
    createdAt: row.created_at,
    teamName: row.team_name,
    userId: row.user_id,
  };
}

export function playoffSeedToResponse(seed: PlayoffSeed) {
  return {
    id: seed.id,
    bracket_id: seed.bracketId,
    roster_id: seed.rosterId,
    seed: seed.seed,
    regular_season_record: seed.regularSeasonRecord,
    points_for: seed.pointsFor,
    has_bye: seed.hasBye,
    bracket_type: seed.bracketType,
    team_name: seed.teamName,
    user_id: seed.userId,
  };
}

export interface PlayoffTeamInfo {
  rosterId: number;
  seed: number;
  teamName: string;
  points: number | null;
  record: string;
}

export function playoffTeamInfoToResponse(team: PlayoffTeamInfo) {
  return {
    roster_id: team.rosterId,
    seed: team.seed,
    team_name: team.teamName,
    points: team.points,
    record: team.record,
  };
}

export interface PlayoffMatchup {
  matchupId: number;
  week: number;
  round: number;
  bracketPosition: number;
  bracketType: BracketType;
  team1: PlayoffTeamInfo | null;
  team2: PlayoffTeamInfo | null;
  winner: PlayoffTeamInfo | null;
  isFinal: boolean;
  // Multi-week series fields
  seriesId: string | null;
  seriesGame: number; // 1 or 2
  seriesLength: number; // 1 or 2
}

export function playoffMatchupToResponse(matchup: PlayoffMatchup) {
  return {
    matchup_id: matchup.matchupId,
    week: matchup.week,
    round: matchup.round,
    bracket_position: matchup.bracketPosition,
    bracket_type: matchup.bracketType,
    team1: matchup.team1 ? playoffTeamInfoToResponse(matchup.team1) : null,
    team2: matchup.team2 ? playoffTeamInfoToResponse(matchup.team2) : null,
    winner: matchup.winner ? playoffTeamInfoToResponse(matchup.winner) : null,
    is_final: matchup.isFinal,
    series_id: matchup.seriesId,
    series_game: matchup.seriesGame,
    series_length: matchup.seriesLength,
  };
}

export interface PlayoffRound {
  round: number;
  week: number; // Start week for this round (deprecated, use weekStart)
  weekStart: number;
  weekEnd: number;
  name: string; // "Quarterfinals", "Semifinals", "Championship"
  matchups: PlayoffMatchup[];
}

export function playoffRoundToResponse(round: PlayoffRound) {
  return {
    round: round.round,
    week: round.week,
    week_start: round.weekStart,
    week_end: round.weekEnd,
    name: round.name,
    matchups: round.matchups.map(playoffMatchupToResponse),
  };
}

export interface PlayoffBracketView {
  bracket: PlayoffBracket;
  seeds: PlayoffSeed[];
  rounds: PlayoffRound[];
  champion: PlayoffTeamInfo | null;
  thirdPlace: { matchup: PlayoffMatchup } | null;
  consolation: { seeds: ConsolationSeed[]; rounds: PlayoffRound[] } | null;
  settings: PlayoffSettings;
}

export interface ConsolationSeed {
  rosterId: number;
  standingsPosition: number;
  teamName: string;
  record: string;
}

export function consolationSeedToResponse(seed: ConsolationSeed) {
  return {
    roster_id: seed.rosterId,
    standings_position: seed.standingsPosition,
    team_name: seed.teamName,
    record: seed.record,
  };
}

export function playoffBracketViewToResponse(view: PlayoffBracketView) {
  return {
    bracket: playoffBracketToResponse(view.bracket),
    seeds: view.seeds.map(playoffSeedToResponse),
    rounds: view.rounds.map(playoffRoundToResponse),
    champion: view.champion ? playoffTeamInfoToResponse(view.champion) : null,
    third_place: view.thirdPlace
      ? { matchup: playoffMatchupToResponse(view.thirdPlace.matchup) }
      : null,
    consolation: view.consolation
      ? {
          seeds: view.consolation.seeds.map(consolationSeedToResponse),
          rounds: view.consolation.rounds.map(playoffRoundToResponse),
        }
      : null,
    settings: playoffSettingsToResponse(view.settings),
  };
}

/**
 * Get round name based on playoff format and round number
 */
export function getRoundName(playoffTeams: number, round: number, totalRounds: number): string {
  if (round === totalRounds) {
    return 'Championship';
  }
  if (round === totalRounds - 1) {
    return 'Semifinals';
  }
  if (playoffTeams === 8 && round === 1) {
    return 'Quarterfinals';
  }
  if (playoffTeams === 6 && round === 1) {
    return 'Wild Card';
  }
  return `Round ${round}`;
}

/**
 * Calculate total rounds based on playoff teams
 */
export function calculateTotalRounds(playoffTeams: number): number {
  if (playoffTeams === 4) return 2;
  if (playoffTeams === 6) return 3;
  if (playoffTeams === 8) return 3;
  return 3; // Default
}

/**
 * Get bracket position for matchup display
 * Positions are numbered to maintain bracket structure
 */
export interface BracketMatchupConfig {
  week: number;
  round: number;
  seed1: number;
  seed2: number | null; // null for bye
  bracketPosition: number;
}

export function generateBracketConfig(
  playoffTeams: number,
  startWeek: number
): BracketMatchupConfig[] {
  if (playoffTeams === 4) {
    // 4-team: 2 rounds
    return [
      // Round 1 - Semifinals
      { week: startWeek, round: 1, seed1: 1, seed2: 4, bracketPosition: 1 },
      { week: startWeek, round: 1, seed1: 2, seed2: 3, bracketPosition: 2 },
      // Championship created after round 1 winners determined
    ];
  }

  if (playoffTeams === 6) {
    // 6-team: 3 rounds, seeds 1-2 have bye
    return [
      // Round 1 - Wild Card (seeds 3-6 play)
      { week: startWeek, round: 1, seed1: 3, seed2: 6, bracketPosition: 1 },
      { week: startWeek, round: 1, seed1: 4, seed2: 5, bracketPosition: 2 },
      // Round 2 - Semifinals (1,2 join as byes)
      // Position 3: #1 seed vs winner of 4v5
      // Position 4: #2 seed vs winner of 3v6
      // Championship after round 2
    ];
  }

  if (playoffTeams === 8) {
    // 8-team: 3 rounds, standard bracket
    return [
      // Round 1 - Quarterfinals
      { week: startWeek, round: 1, seed1: 1, seed2: 8, bracketPosition: 1 },
      { week: startWeek, round: 1, seed1: 4, seed2: 5, bracketPosition: 2 },
      { week: startWeek, round: 1, seed1: 3, seed2: 6, bracketPosition: 3 },
      { week: startWeek, round: 1, seed1: 2, seed2: 7, bracketPosition: 4 },
      // Semifinals and Championship created as winners advance
    ];
  }

  return [];
}

/**
 * Generate consolation bracket matchup configuration
 */
export function generateConsolationBracketConfig(
  consolationTeams: number,
  startWeek: number
): BracketMatchupConfig[] {
  if (consolationTeams === 4) {
    return [
      // Semifinal round - positions 1-2 in consolation
      { week: startWeek, round: 1, seed1: 1, seed2: 4, bracketPosition: 1 },
      { week: startWeek, round: 1, seed1: 2, seed2: 3, bracketPosition: 2 },
      // Final created after round 1
    ];
  }

  if (consolationTeams === 6) {
    return [
      // Wild Card - seeds 3-6 play, 1-2 have bye
      { week: startWeek, round: 1, seed1: 3, seed2: 6, bracketPosition: 1 },
      { week: startWeek, round: 1, seed1: 4, seed2: 5, bracketPosition: 2 },
      // Semifinals and final created as winners advance
    ];
  }

  if (consolationTeams === 8) {
    return [
      // Quarterfinals
      { week: startWeek, round: 1, seed1: 1, seed2: 8, bracketPosition: 1 },
      { week: startWeek, round: 1, seed1: 4, seed2: 5, bracketPosition: 2 },
      { week: startWeek, round: 1, seed1: 3, seed2: 6, bracketPosition: 3 },
      { week: startWeek, round: 1, seed1: 2, seed2: 7, bracketPosition: 4 },
    ];
  }

  return [];
}

/**
 * Get round name for consolation bracket
 */
export function getConsolationRoundName(
  consolationTeams: number,
  round: number,
  totalRounds: number
): string {
  if (round === totalRounds) {
    return 'Consolation Final';
  }
  if (round === totalRounds - 1) {
    return 'Consolation Semifinals';
  }
  if (consolationTeams === 8 && round === 1) {
    return 'Consolation Quarterfinals';
  }
  if (consolationTeams === 6 && round === 1) {
    return 'Consolation Wild Card';
  }
  return `Consolation Round ${round}`;
}

/**
 * Calculate the week range for a specific round given weeksByRound config
 * @param startWeek - Playoff start week
 * @param weeksByRound - Array of weeks per round, e.g., [1, 2, 2]
 * @param round - Round number (1-indexed)
 * @returns { weekStart, weekEnd }
 */
export function getWeekRangeForRound(
  startWeek: number,
  weeksByRound: number[] | null,
  round: number
): { weekStart: number; weekEnd: number } {
  // Default to 1 week per round if not specified
  const weeksArray = weeksByRound ?? [];

  let weekStart = startWeek;
  for (let r = 0; r < round - 1; r++) {
    weekStart += weeksArray[r] ?? 1;
  }

  const weeksForRound = weeksArray[round - 1] ?? 1;
  const weekEnd = weekStart + weeksForRound - 1;

  return { weekStart, weekEnd };
}

/**
 * Calculate the week for a specific game in a round
 * @param startWeek - Playoff start week
 * @param weeksByRound - Array of weeks per round
 * @param round - Round number (1-indexed)
 * @param game - Game number in series (1 or 2)
 */
export function getWeekForRoundGame(
  startWeek: number,
  weeksByRound: number[] | null,
  round: number,
  game: number
): number {
  const { weekStart } = getWeekRangeForRound(startWeek, weeksByRound, round);
  return weekStart + game - 1;
}

/**
 * Calculate total playoff weeks given weeksByRound configuration
 */
export function calculateTotalPlayoffWeeks(
  weeksByRound: number[] | null,
  totalRounds: number
): number {
  if (!weeksByRound) {
    return totalRounds; // 1 week per round
  }
  return weeksByRound.reduce((sum, weeks) => sum + weeks, 0);
}

/**
 * Get default weeksByRound for a given number of rounds (all 1-week)
 */
export function getDefaultWeeksByRound(totalRounds: number): number[] {
  return Array(totalRounds).fill(1);
}
