/**
 * Playoff Seeding Domain Logic
 *
 * Pure functions for playoff seeding, standings sorting, and config validation.
 * No async I/O, no database access.
 */

/**
 * Minimal standing data needed for seeding.
 * Domain does not import from modules — callers map from their Standing type.
 */
export interface StandingForSeeding {
  rosterId: number;
  wins: number;
  losses: number;
  ties: number;
  pointsFor: number;
}

export interface PlayoffSeedInput {
  rosterId: number;
  seed: number;
  regularSeasonRecord: string;
  pointsFor: number;
  hasBye: boolean;
}

/**
 * Sort standings for playoff seeding.
 * Order: Wins DESC > Points For DESC > RosterId ASC (deterministic tie-break)
 *
 * @param standings - Array of standings to sort (mutated in place and returned)
 * @returns Sorted standings array
 */
export function sortStandingsForSeeding<T extends StandingForSeeding>(standings: T[]): T[] {
  return standings.sort((a, b) => {
    if (a.wins !== b.wins) return b.wins - a.wins;
    if (a.pointsFor !== b.pointsFor) return b.pointsFor - a.pointsFor;
    return a.rosterId - b.rosterId; // Deterministic tie-break
  });
}

/**
 * Generate playoff seed inputs from sorted standings.
 *
 * @param sortedStandings - Standings already sorted by seeding rules
 * @param playoffTeams - Number of teams in playoffs (4, 6, or 8)
 * @returns Array of seed inputs for bracket creation
 */
export function seedFromStandings(
  sortedStandings: StandingForSeeding[],
  playoffTeams: number
): PlayoffSeedInput[] {
  const topTeams = sortedStandings.slice(0, playoffTeams);
  const byeSeeds = computeByeSeeds(playoffTeams);

  return topTeams.map((standing, index) => ({
    rosterId: standing.rosterId,
    seed: index + 1,
    regularSeasonRecord: `${standing.wins}-${standing.losses}${standing.ties > 0 ? `-${standing.ties}` : ''}`,
    pointsFor: standing.pointsFor,
    hasBye: byeSeeds.includes(index + 1),
  }));
}

/**
 * Compute which seeds receive a first-round bye.
 * 6-team brackets: seeds 1 and 2 get byes.
 * All other formats: no byes.
 *
 * @param playoffTeams - Number of teams in playoffs
 * @returns Array of seed numbers that receive byes
 */
export function computeByeSeeds(playoffTeams: number): number[] {
  return playoffTeams === 6 ? [1, 2] : [];
}

/**
 * Validate playoff configuration.
 *
 * Checks:
 * - Team count is 4, 6, or 8
 * - weeksByRound length matches total rounds (if provided)
 * - Each weeksByRound value is 1 or 2
 * - Consolation team count is valid
 * - Enough non-playoff teams for consolation
 *
 * @param config - Playoff configuration to validate
 * @returns Array of error messages (empty if valid)
 */
export function validatePlayoffConfig(config: {
  playoffTeams: number;
  totalRounds: number;
  weeksByRound?: number[] | null;
  consolationType?: string;
  consolationTeams?: number | null;
  totalLeagueTeams?: number;
}): string[] {
  const errors: string[] = [];

  if (![4, 6, 8].includes(config.playoffTeams)) {
    errors.push('Playoff teams must be 4, 6, or 8');
  }

  if (config.weeksByRound) {
    if (config.weeksByRound.length !== config.totalRounds) {
      errors.push(
        `weeksByRound must have ${config.totalRounds} elements for ${config.playoffTeams}-team playoffs, got ${config.weeksByRound.length}`
      );
    }
    for (let i = 0; i < config.weeksByRound.length; i++) {
      if (config.weeksByRound[i] !== 1 && config.weeksByRound[i] !== 2) {
        errors.push(`weeksByRound[${i}] must be 1 or 2, got ${config.weeksByRound[i]}`);
      }
    }
  }

  if (config.consolationType === 'CONSOLATION' && config.totalLeagueTeams !== undefined) {
    const nonPlayoffTeams = config.totalLeagueTeams - config.playoffTeams;

    if (nonPlayoffTeams < 4) {
      errors.push(
        `Not enough teams for consolation bracket. Need at least 4 non-playoff teams, have ${nonPlayoffTeams}`
      );
    }

    if (config.consolationTeams !== undefined && config.consolationTeams !== null) {
      if (![4, 6, 8].includes(config.consolationTeams)) {
        errors.push('Consolation teams must be 4, 6, or 8');
      }
      if (config.consolationTeams > nonPlayoffTeams) {
        errors.push(
          `Cannot have ${config.consolationTeams} consolation teams with only ${nonPlayoffTeams} non-playoff teams`
        );
      }
    }
  }

  return errors;
}
