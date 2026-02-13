import { Request } from 'express';
import { AuthRequest } from '../middleware/auth.middleware';
import { ValidationException } from './exceptions';
import { parseIntParam } from './params';

// Import for side-effect: registers leagueSeasonId on Express.Request globally
import '../middleware/season-context.middleware';

/**
 * Controller helper functions for common validation patterns.
 * Use these to reduce boilerplate in controller methods.
 */

/**
 * Extract and validate user ID from authenticated request.
 * @throws ValidationException if user ID is not found
 */
export function requireUserId(req: AuthRequest): string {
  const userId = req.user?.userId;
  if (!userId) throw new ValidationException('User ID not found');
  return userId;
}

/**
 * Parse and validate league ID from request params.
 * Checks both 'leagueId' and 'id' param names.
 * @throws ValidationException if league ID is invalid
 */
export function requireLeagueId(req: Request): number {
  const leagueId = parseIntParam(req.params.leagueId ?? req.params.id);
  if (isNaN(leagueId)) throw new ValidationException('Invalid league ID');
  return leagueId;
}

/**
 * Parse and validate draft ID from request params.
 * @throws ValidationException if draft ID is invalid
 */
export function requireDraftId(req: Request): number {
  const draftId = parseIntParam(req.params.draftId);
  if (isNaN(draftId)) throw new ValidationException('Invalid draft ID');
  return draftId;
}

/**
 * Parse and validate player ID from request params or body.
 * Checks playerId param, id param, and player_id body field.
 * @throws ValidationException if player ID is invalid
 */
export function requirePlayerId(req: Request): number {
  const playerId = parseIntParam(req.params.playerId ?? req.params.id ?? req.body.player_id);
  if (isNaN(playerId)) throw new ValidationException('Invalid player ID');
  return playerId;
}

/**
 * Extract leagueSeasonId from request (set by resolveSeasonContext middleware).
 * @throws ValidationException if leagueSeasonId is not set
 */
export function requireLeagueSeasonId(req: Request): number {
  const leagueSeasonId = req.leagueSeasonId;
  if (!leagueSeasonId) throw new ValidationException('League season context not resolved');
  return leagueSeasonId;
}
