/**
 * Draft Player Ranking Domain Logic
 *
 * Single source of truth for ADP-based player ranking.
 * Merges duplicate logic from:
 * - BaseDraftEngine.performAutoPickPlayer() (delegates to repo)
 * - DraftStateService.getBestAvailablePlayer() (inline SQL)
 *
 * These functions operate on in-memory arrays. For SQL-level ranking
 * (used in production for efficiency), the sort order must match:
 * ORDER BY adp ASC NULLS LAST, id ASC
 *
 * No async I/O, no database access.
 */

/**
 * Minimal player data needed for ADP ranking.
 */
export interface PlayerForRanking {
  id: number;
  adp: number | null;
}

/**
 * Rank players by ADP (Average Draft Position).
 *
 * Sort order: ADP ascending, nulls last, then by player ID ascending.
 * This must match the SQL: ORDER BY adp ASC NULLS LAST, id ASC
 *
 * @param players - Array of players to rank (not mutated)
 * @returns New sorted array
 */
export function rankPlayersByAdp<T extends PlayerForRanking>(players: T[]): T[] {
  return [...players].sort((a, b) => {
    // Both have ADP
    if (a.adp !== null && b.adp !== null) {
      if (a.adp !== b.adp) return a.adp - b.adp;
      return a.id - b.id;
    }
    // Nulls last
    if (a.adp === null && b.adp !== null) return 1;
    if (a.adp !== null && b.adp === null) return -1;
    // Both null: sort by ID
    return a.id - b.id;
  });
}

/**
 * Get the best available player by ADP ranking.
 *
 * @param players - Array of available players
 * @returns The best player by ADP, or null if empty
 */
export function getBestByAdp<T extends PlayerForRanking>(players: T[]): T | null {
  if (players.length === 0) return null;
  const ranked = rankPlayersByAdp(players);
  return ranked[0];
}
