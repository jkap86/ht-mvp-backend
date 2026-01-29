import { Response, NextFunction } from 'express';
import { AuthRequest } from '../../middleware/auth.middleware';
import { MatchupService } from './matchups.service';
import { ScoringService } from '../scoring/scoring.service';
import { ScheduleGeneratorService } from './schedule-generator.service';
import { StandingsService } from './standings.service';
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
    private readonly standingsService?: StandingsService
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
  }

  // GET /api/leagues/:leagueId/matchups
  async getMatchups(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const leagueId = requireLeagueId(req);
      const userId = requireUserId(req);
      const week = parseInt(req.query.week as string, 10) || 1;

      const matchups = await this.matchupService.getWeekMatchups(leagueId, week, userId);
      res.json({ matchups: matchups.map(matchupDetailsToResponse) });
    } catch (error) {
      next(error);
    }
  }

  // GET /api/leagues/:leagueId/matchups/:matchupId
  async getMatchup(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const matchupId = parseIntParam(req.params.matchupId);
      const userId = requireUserId(req);

      if (isNaN(matchupId)) throw new ValidationException('Invalid matchup ID');

      const matchup = await this.matchupService.getMatchup(matchupId, userId);
      if (!matchup) {
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
      const matchupId = parseIntParam(req.params.matchupId);
      const userId = requireUserId(req);

      if (isNaN(matchupId)) throw new ValidationException('Invalid matchup ID');

      const matchup = await this.matchupService.getMatchupWithLineups(matchupId, userId);
      if (!matchup) {
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

      await this.matchupService.finalizeWeekMatchups(leagueId, week, userId);
      res.json({ success: true, message: `Week ${week} matchups finalized` });
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

      await this.scoringService.calculateWeeklyScores(leagueId, week, userId);
      res.json({ success: true, message: `Scores calculated for week ${week}` });
    } catch (error) {
      next(error);
    }
  }
}
