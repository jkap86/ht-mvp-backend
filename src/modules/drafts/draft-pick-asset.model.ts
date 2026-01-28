/**
 * Draft pick asset models
 * Represents tradeable draft pick ownership
 */

export interface DraftPickAsset {
  id: number;
  leagueId: number;
  draftId: number | null;
  season: number;
  round: number;
  originalRosterId: number;
  currentOwnerRosterId: number;
  originalPickPosition: number | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Extended draft pick asset with team/user details
 */
export interface DraftPickAssetWithDetails extends DraftPickAsset {
  originalTeamName: string;
  originalUsername: string;
  currentOwnerTeamName: string;
  currentOwnerUsername: string;
}

/**
 * Convert database row to DraftPickAsset
 */
export function draftPickAssetFromDatabase(row: any): DraftPickAsset {
  return {
    id: row.id,
    leagueId: row.league_id,
    draftId: row.draft_id,
    season: row.season,
    round: row.round,
    originalRosterId: row.original_roster_id,
    currentOwnerRosterId: row.current_owner_roster_id,
    originalPickPosition: row.original_pick_position,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Convert DraftPickAsset to API response (snake_case)
 */
export function draftPickAssetToResponse(asset: DraftPickAsset): Record<string, any> {
  return {
    id: asset.id,
    league_id: asset.leagueId,
    draft_id: asset.draftId,
    season: asset.season,
    round: asset.round,
    original_roster_id: asset.originalRosterId,
    current_owner_roster_id: asset.currentOwnerRosterId,
    original_pick_position: asset.originalPickPosition,
    created_at: asset.createdAt,
    updated_at: asset.updatedAt,
  };
}

/**
 * Convert DraftPickAssetWithDetails to API response
 */
export function draftPickAssetWithDetailsToResponse(
  asset: DraftPickAssetWithDetails
): Record<string, any> {
  return {
    ...draftPickAssetToResponse(asset),
    original_team_name: asset.originalTeamName,
    original_username: asset.originalUsername,
    current_owner_team_name: asset.currentOwnerTeamName,
    current_owner_username: asset.currentOwnerUsername,
  };
}

/**
 * Generate display name for a draft pick asset
 * Example: "2025 Round 1" or "2025 Round 1 (Team A's pick)"
 */
export function formatPickAssetDisplay(asset: DraftPickAssetWithDetails): string {
  const isTraded = asset.originalRosterId !== asset.currentOwnerRosterId;
  const suffix = isTraded ? ` (${asset.originalTeamName}'s pick)` : '';
  return `${asset.season} Round ${asset.round}${suffix}`;
}

/**
 * Check if a pick asset has been traded
 */
export function isPickAssetTraded(asset: DraftPickAsset): boolean {
  return asset.originalRosterId !== asset.currentOwnerRosterId;
}
