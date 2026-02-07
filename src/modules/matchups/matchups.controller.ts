import { Response, NextFunction } from 'express';
import { AuthRequest } from '../../middleware/auth.middleware';
import { MatchupService } from './matchups.service';
import { ScoringService } from '../scoring/scoring.service';
import { ScheduleGeneratorService } from './schedule-generator.service';
import { StandingsService } from './standings.service';
import { MedianService } from './median.service';
import {
  matchupDetailsToResponse,
  matchupWithLineupsToResponse,
  standingToResponse,
} from './matchups.model';
import { requireUserId, requireLeagueId } from '../../utils/controller-helpers';
import { parseIntParam } from '../../utils/params';
import { ValidationException } from '../../utils/exceptions';

export class MatchupsController {
  constructor(
    private readonly matchupService: MatchupService,
    private readonly scoringService: ScoringService,
    private readonly scheduleGeneratorService?: ScheduleGeneratorService,
    private readonly standingsService?: StandingsService,
    private readonly medianService?: MedianService
  ) {
    // Bind methods to preserve 'this' context
    this.getMatchups = this.getMatchups.bind(this);
    this.getMatchup = this.getMatchup.bind(this);
    this.getMatchupWithLineups = this.getMatchupWithLineups.bind(this);
    this.getStandings = this.getStandings.bind(this);
    this.generateSchedule = this.generateSchedule.bind(this);
    this.finalizeMatchups = this.finalizeMatchups.bind(this);
    this.getScoringRules = this.getScoringRules.bind(this);
    this.calculateScores = this.calculateScores.bind(this);
    this.recalculateMedian = this.recalculateMedian.bind(this);
  }

  // GET /api/leagues/:leagueId/matchups
  // Query params:
  //   - week (optional): If provided, returns matchups for that week only.
  //                      If omitted, returns all matchups for the season.
  //   - season (optional): Filter by season year. Defaults to league's current season.
  async getMatchups(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const leagueId = requireLeagueId(req);
      const userId = requireUserId(req);

      // Parse optional week parameter - if not provided, return all matchups
      const weekParam = req.query.week as string | undefined;
      const weekParsed = weekParam !== undefined ? parseInt(weekParam, 10) : undefined;
      const week = weekParsed !== undefined && !isNaN(weekParsed) && weekParsed >= 1
        ? weekParsed
        : undefined;

      // Parse optional season parameter
      const seasonParam = req.query.season as string | undefined;
      const seasonParsed = seasonParam ? parseInt(seasonParam, 10) : undefined;
      const season = seasonParsed && !isNaN(seasonParsed) ? seasonParsed : undefined;

      let matchups;
      if (week !== undefined) {
        // Fetch matchups for specific week
        matchups = await this.matchupService.getWeekMatchups(leagueId, week, userId);
      } else {
        // Fetch all matchups for the season (no week filter)
        matchups = await this.matchupService.getAllMatchups(leagueId, userId, season);
      }

      res.json({ matchups: matchups.map(matchupDetailsToResponse) });
    } catch (error) {
      next(error);
    }
  }

  // GET /api/leagues/:leagueId/matchups/:matchupId
  async getMatchup(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const leagueId = requireLeagueId(req);
      const matchupId = parseIntParam(req.params.matchupId);
      const userId = requireUserId(req);

      if (isNaN(matchupId)) throw new ValidationException('Invalid matchup ID');

      const matchup = await this.matchupService.getMatchup(matchupId, userId);
      if (!matchup) {
        res.status(404).json({ error: 'Matchup not found' });
        return;
      }

      // Verify the matchup belongs to the specified league
      if (matchup.leagueId !== leagueId) {
        res.status(404).json({ error: 'Matchup not found' });
        return;
      }

      res.json({ matchup: matchupDetailsToResponse(matchup) });
    } catch (error) {
      next(error);
    }
  }

  // GET /api/leagues/:leagueId/matchups/:matchupId/detail
  async getMatchupWithLineups(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const leagueId = requireLeagueId(req);
      const matchupId = parseIntParam(req.params.matchupId);
      const userId = requireUserId(req);

      if (isNaN(matchupId)) throw new ValidationException('Invalid matchup ID');

      const matchup = await this.matchupService.getMatchupWithLineups(matchupId, userId);
      if (!matchup) {
        res.status(404).json({ error: 'Matchup not found' });
        return;
      }

      // Verify the matchup belongs to the specified league
      if (matchup.leagueId !== leagueId) {
        res.status(404).json({ error: 'Matchup not found' });
        return;
      }

      res.json({ matchup: matchupWithLineupsToResponse(matchup) });
    } catch (error) {
      next(error);
    }
  }

  // GET /api/leagues/:leagueId/standings
  async getStandings(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const leagueId = requireLeagueId(req);
      const userId = requireUserId(req);

      // Call StandingsService directly (no longer through MatchupService)
      if (!this.standingsService) {
        throw new ValidationException('Standings service not available');
      }
      const standings = await this.standingsService.getStandings(leagueId, userId);
      res.json({ standings: standings.map(standingToResponse) });
    } catch (error) {
      next(error);
    }
  }

  // POST /api/leagues/:leagueId/schedule/generate
  async generateSchedule(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const leagueId = requireLeagueId(req);
      const userId = requireUserId(req);
      const { weeks } = req.body;

      // Call ScheduleGeneratorService directly (no longer through MatchupService)
      if (!this.scheduleGeneratorService) {
        throw new ValidationException('Schedule generator service not available');
      }
      await this.scheduleGeneratorService.generateSchedule(leagueId, weeks || 14, userId);
      res.json({ success: true, message: `Schedule generated for ${weeks || 14} weeks` });
    } catch (error) {
      next(error);
    }
  }

  // POST /api/leagues/:leagueId/matchups/finalize
  async finalizeMatchups(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const leagueId = requireLeagueId(req);
      const userId = requireUserId(req);
      const { week } = req.body;

      // Validate week parameter
      if (week === undefined || week === null) {
        throw new ValidationException('Week is required');
      }
      const weekNum = parseInt(week, 10);
      if (isNaN(weekNum) || weekNum < 1) {
        throw new ValidationException('Week must be a positive integer');
      }

      await this.matchupService.finalizeWeekMatchups(leagueId, weekNum, userId);
      res.json({ success: true, message: `Week ${weekNum} matchups finalized` });
    } catch (error) {
      next(error);
    }
  }

  // GET /api/leagues/:leagueId/scoring/rules
  async getScoringRules(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const leagueId = requireLeagueId(req);
      const userId = requireUserId(req);

      const rules = await this.scoringService.getScoringRules(leagueId, userId);
      res.json({ rules });
    } catch (error) {
      next(error);
    }
  }

  // POST /api/leagues/:leagueId/scoring/calculate
  async calculateScores(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const leagueId = requireLeagueId(req);
      const userId = requireUserId(req);
      const { week } = req.body;

      // Validate week parameter
      if (week === undefined || week === null) {
        throw new ValidationException('Week is required');
      }
      const weekNum = parseInt(week, 10);
      if (isNaN(weekNum) || weekNum < 1) {
        throw new ValidationException('Week must be a positive integer');
      }

      await this.scoringService.calculateWeeklyScores(leagueId, weekNum, userId);
      res.json({ success: true, message: `Scores calculated for week ${weekNum}` });
    } catch (error) {
      next(error);
    }
  }

  // POST /api/leagues/:leagueId/median/recalculate
  // Recalculates median results for a finalized week (commissioner only)
  async recalculateMedian(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const leagueId = requireLeagueId(req);
      const userId = requireUserId(req);
      const { week } = req.body;

      // Validate week parameter
      if (week === undefined || week === null) {
        throw new ValidationException('Week is required');
      }
      const weekNum = parseInt(week, 10);
      if (isNaN(weekNum) || weekNum < 1) {
        throw new ValidationException('Week must be a positive integer');
      }

      if (!this.medianService) {
        throw new ValidationException('Median service not available');
      }

      // MedianService handles commissioner validation internally
      const result = await this.medianService.recalculateWeekMedian(
        leagueId,
        new Date().getFullYear(), // Current season
        weekNum,
        userId
      );

      res.json({
        success: true,
        message: `Median results recalculated for week ${weekNum}`,
        median_points: result.medianPoints,
      });
    } catch (error) {
      next(error);
    }
  }
}
