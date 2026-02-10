/**
 * Centralized default values for roster configuration.
 * Replaces the scattered `league.settings?.roster_size || 15` pattern.
 */

const DEFAULT_MAX_ROSTER_SIZE = 15;

/**
 * Extract max roster size from league settings with default fallback.
 */
export function getMaxRosterSize(leagueSettings: any): number {
  return leagueSettings?.roster_size || DEFAULT_MAX_ROSTER_SIZE;
}
