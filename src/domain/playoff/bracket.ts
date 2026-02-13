/**
 * Playoff Bracket Domain Logic
 *
 * Single source of truth for matchup/series winner resolution and tiebreaks.
 * Consolidates 3 duplicate implementations from:
 * - PlayoffService.determineWinner/determineLoser
 * - PlayoffService.determineSeriesWinner/determineSeriesLoser
 * - BasePlayoffEngine.determineSeriesWinner/determineSeriesLoser
 *
 * No async I/O, no database access.
 */

/**
 * Minimal matchup data needed for winner resolution.
 * Domain does not import from modules — callers map from their row types.
 */
export interface MatchupForResolution {
  roster1Id: number;
  roster2Id: number;
  roster1Points: number | null;
  roster2Points: number | null;
  roster1Seed: number;
  roster2Seed: number;
}

/**
 * Minimal series data needed for winner resolution.
 */
export interface SeriesForResolution {
  roster1Id: number;
  roster2Id: number;
  roster1TotalPoints: number;
  roster2TotalPoints: number;
  roster1Seed: number;
  roster2Seed: number;
}

/**
 * Resolve the winner of a single matchup.
 *
 * Tiebreak order:
 * 1. Points (higher wins)
 * 2. Seed (lower seed number = higher seed wins)
 * 3. Roster ID (lower wins — arbitrary but deterministic)
 *
 * @param matchup - Matchup data with points and seeds
 * @param requirePoints - If true, throws when points are null/undefined
 * @returns The winning roster ID
 * @throws Error if requirePoints is true and points are missing
 */
export function resolveMatchupWinner(
  matchup: MatchupForResolution,
  requirePoints: boolean = false
): number {
  const { roster1Id, roster2Id, roster1Points, roster2Points, roster1Seed, roster2Seed } = matchup;

  if (requirePoints) {
    if (roster1Points === null || roster1Points === undefined ||
        roster2Points === null || roster2Points === undefined) {
      throw new Error('Cannot resolve winner: matchup is missing scores');
    }
  }

  const pts1 = roster1Points === null || roster1Points === undefined ? 0 : Number(roster1Points);
  const pts2 = roster2Points === null || roster2Points === undefined ? 0 : Number(roster2Points);

  if (pts1 > pts2) return roster1Id;
  if (pts2 > pts1) return roster2Id;

  // Tie: higher seed (lower seed number) wins
  if (roster1Seed < roster2Seed) return roster1Id;
  if (roster2Seed < roster1Seed) return roster2Id;

  // Final fallback: lower roster ID wins (deterministic)
  return roster1Id < roster2Id ? roster1Id : roster2Id;
}

/**
 * Resolve the loser of a single matchup.
 *
 * @param matchup - Matchup data with points and seeds
 * @param requirePoints - If true, throws when points are missing
 * @returns The losing roster ID
 */
export function resolveMatchupLoser(
  matchup: MatchupForResolution,
  requirePoints: boolean = false
): number {
  const winnerId = resolveMatchupWinner(matchup, requirePoints);
  return winnerId === matchup.roster1Id ? matchup.roster2Id : matchup.roster1Id;
}

/**
 * Resolve the winner of a series using aggregate scoring.
 *
 * Tiebreak order:
 * 1. Total aggregate points (higher wins)
 * 2. Seed (lower seed number = higher seed wins)
 * 3. Roster ID (lower wins — arbitrary but deterministic)
 *
 * @param series - Series data with aggregate points and seeds
 * @returns The winning roster ID
 */
export function resolveSeriesWinner(series: SeriesForResolution): number {
  if (series.roster1TotalPoints > series.roster2TotalPoints) {
    return series.roster1Id;
  }
  if (series.roster2TotalPoints > series.roster1TotalPoints) {
    return series.roster2Id;
  }

  // Tie: lower seed number wins
  if (series.roster1Seed < series.roster2Seed) return series.roster1Id;
  if (series.roster2Seed < series.roster1Seed) return series.roster2Id;

  // Final fallback: lower roster ID wins (deterministic)
  return series.roster1Id < series.roster2Id ? series.roster1Id : series.roster2Id;
}

/**
 * Resolve the loser of a series using aggregate scoring.
 *
 * @param series - Series data with aggregate points and seeds
 * @returns The losing roster ID
 */
export function resolveSeriesLoser(series: SeriesForResolution): number {
  const winnerId = resolveSeriesWinner(series);
  return winnerId === series.roster1Id ? series.roster2Id : series.roster1Id;
}

/**
 * Check if a bracket is complete.
 *
 * A bracket is complete when:
 * - A champion has been determined
 * - If third place is enabled, a third place winner exists
 * - If consolation is enabled, a consolation winner exists
 *
 * @param bracket - Bracket state to check
 * @returns Whether the bracket is fully complete
 */
export function isBracketComplete(bracket: {
  championRosterId: number | null;
  enableThirdPlace: boolean;
  thirdPlaceRosterId: number | null;
  consolationType: string;
  consolationWinnerRosterId: number | null;
}): boolean {
  if (!bracket.championRosterId) return false;
  if (bracket.enableThirdPlace && !bracket.thirdPlaceRosterId) return false;
  if (bracket.consolationType === 'CONSOLATION' && !bracket.consolationWinnerRosterId) return false;
  return true;
}
