import { Response, NextFunction } from 'express';
import { AuthRequest } from '../../middleware/auth.middleware';
import { DraftPickAssetRepository } from './draft-pick-asset.repository';
import { AuthorizationService } from '../auth/authorization.service';
import { RosterRepository } from '../leagues/leagues.repository';
import { requireUserId, requireLeagueId } from '../../utils/controller-helpers';
import { ValidationException, ForbiddenException } from '../../utils/exceptions';
import { draftPickAssetWithDetailsToResponse } from './draft-pick-asset.model';
import { parseIntParam } from '../../utils/params';

export class DraftPickAssetsController {
  constructor(
    private readonly pickAssetRepo: DraftPickAssetRepository,
    private readonly authService: AuthorizationService,
    private readonly rosterRepo: RosterRepository
  ) {}

  /**
   * GET /api/leagues/:leagueId/pick-assets
   * Get all pick assets for a league (requires membership)
   */
  getLeaguePickAssets = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = requireUserId(req);
      const leagueId = requireLeagueId(req);

      // Verify user is a member of the league
      await this.authService.ensureLeagueMember(leagueId, userId);

      // Get all seasons that have pick assets for this league
      const seasons = await this.pickAssetRepo.getSeasons(leagueId);

      // Get pick assets for all seasons
      const pickAssetsBySeason: Record<number, any[]> = {};
      for (const season of seasons) {
        const assets = await this.pickAssetRepo.findByLeagueAndSeason(leagueId, season);
        pickAssetsBySeason[season] = assets.map(draftPickAssetWithDetailsToResponse);
      }

      res.status(200).json({
        league_id: leagueId,
        seasons,
        pick_assets: pickAssetsBySeason,
      });
    } catch (error) {
      next(error);
    }
  };

  /**
   * GET /api/leagues/:leagueId/pick-assets/:season
   * Get pick assets for a specific season (requires membership)
   */
  getSeasonPickAssets = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = requireUserId(req);
      const leagueId = requireLeagueId(req);
      const season = parseIntParam(req.params.season);

      if (isNaN(season)) {
        throw new ValidationException('Invalid season');
      }

      // Verify user is a member of the league
      await this.authService.ensureLeagueMember(leagueId, userId);

      // Get pick assets for the specified season
      const assets = await this.pickAssetRepo.findByLeagueAndSeason(leagueId, season);

      res.status(200).json({
        league_id: leagueId,
        season,
        pick_assets: assets.map(draftPickAssetWithDetailsToResponse),
      });
    } catch (error) {
      next(error);
    }
  };

  /**
   * GET /api/rosters/:rosterId/pick-assets
   * Get pick assets owned by a roster (requires ownership or same league membership)
   */
  getRosterPickAssets = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = requireUserId(req);
      const rosterId = parseIntParam(req.params.rosterId);

      if (isNaN(rosterId)) {
        throw new ValidationException('Invalid roster ID');
      }

      // Get the roster to find its league
      const roster = await this.rosterRepo.findById(rosterId);
      if (!roster) {
        throw new ValidationException('Roster not found');
      }

      // Verify user is a member of the same league
      const userRoster = await this.authService.getLeagueMembership(roster.leagueId, userId);
      if (!userRoster) {
        throw new ForbiddenException('You are not a member of this league');
      }

      // Get pick assets owned by this roster
      const assets = await this.pickAssetRepo.findByOwner(rosterId, roster.leagueId);

      res.status(200).json({
        roster_id: rosterId,
        league_id: roster.leagueId,
        pick_assets: assets.map(draftPickAssetWithDetailsToResponse),
      });
    } catch (error) {
      next(error);
    }
  };
}
