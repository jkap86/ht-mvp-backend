import { Response } from 'express';
import { AuthRequest } from '../../middleware/auth.middleware';
import { MatchupService } from './matchups.service';
import { ScoringService } from '../scoring/scoring.service';
import { ScheduleGeneratorService } from './schedule-generator.service';
import { StandingsService } from './standings.service';
import { MedianService } from './median.service';
import { LeagueService } from '../leagues/leagues.service';
import {
  matchupDetailsToResponse,
  matchupWithLineupsToResponse,
  standingToResponse,
} from './matchups.model';
import { requireUserId, requireLeagueId, requireLeagueSeasonId } from '../../utils/controller-helpers';
import { parseIntParam } from '../../utils/params';
import { ValidationException, ForbiddenException } from '../../utils/exceptions';

export class MatchupsController {
  constructor(
    private readonly matchupService: MatchupService,
    private readonly scoringService: ScoringService,
    private readonly leagueService: LeagueService,
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

  async getMatchups(req: AuthRequest, res: Response): Promise<void> {
    const leagueId = requireLeagueId(req);
    const userId = requireUserId(req);
    const leagueSeasonId = req.leagueSeasonId;

    const weekParam = req.query.week as string | undefined;
    const weekParsed = weekParam !== undefined ? parseInt(weekParam, 10) : undefined;
    const week = weekParsed !== undefined && !isNaN(weekParsed) && weekParsed >= 1
      ? weekParsed
      : undefined;

    const seasonParam = req.query.season as string | undefined;
    const seasonParsed = seasonParam ? parseInt(seasonParam, 10) : undefined;
    const season = seasonParsed && !isNaN(seasonParsed) ? seasonParsed : undefined;

    let matchups;
    if (week !== undefined) {
      matchups = await this.matchupService.getWeekMatchups(leagueId, week, userId, leagueSeasonId);
    } else {
      matchups = await this.matchupService.getAllMatchups(leagueId, userId, season, leagueSeasonId);
    }

    res.json({ matchups: matchups.map(matchupDetailsToResponse) });
  }

  async getMatchup(req: AuthRequest, res: Response): Promise<void> {
    const leagueId = requireLeagueId(req);
    const matchupId = parseIntParam(req.params.matchupId);
    const userId = requireUserId(req);

    if (isNaN(matchupId)) throw new ValidationException('Invalid matchup ID');

    const matchup = await this.matchupService.getMatchup(matchupId, userId);
    if (!matchup) {
      res.status(404).json({ error: 'Matchup not found' });
      return;
    }

    if (matchup.leagueId !== leagueId) {
      res.status(404).json({ error: 'Matchup not found' });
      return;
    }

    res.json({ matchup: matchupDetailsToResponse(matchup) });
  }

  async getMatchupWithLineups(req: AuthRequest, res: Response): Promise<void> {
    const leagueId = requireLeagueId(req);
    const matchupId = parseIntParam(req.params.matchupId);
    const userId = requireUserId(req);

    if (isNaN(matchupId)) throw new ValidationException('Invalid matchup ID');

    const matchup = await this.matchupService.getMatchupWithLineups(matchupId, userId);
    if (!matchup) {
      res.status(404).json({ error: 'Matchup not found' });
      return;
    }

    if (matchup.leagueId !== leagueId) {
      res.status(404).json({ error: 'Matchup not found' });
      return;
    }

    res.json({ matchup: matchupWithLineupsToResponse(matchup) });
  }

  async getStandings(req: AuthRequest, res: Response): Promise<void> {
    const leagueId = requireLeagueId(req);
    const userId = requireUserId(req);

    if (!this.standingsService) {
      throw new ValidationException('Standings service not available');
    }
    const standings = await this.standingsService.getStandings(leagueId, userId);
    res.json({ standings: standings.map(standingToResponse) });
  }

  async generateSchedule(req: AuthRequest, res: Response): Promise<void> {
    const leagueId = requireLeagueId(req);
    const userId = requireUserId(req);
    const { weeks } = req.body;

    if (!this.scheduleGeneratorService) {
      throw new ValidationException('Schedule generator service not available');
    }
    await this.scheduleGeneratorService.generateSchedule(leagueId, weeks || 14, userId);
    res.json({ success: true, message: `Schedule generated for ${weeks || 14} weeks` });
  }

  async finalizeMatchups(req: AuthRequest, res: Response): Promise<void> {
    const leagueId = requireLeagueId(req);
    const userId = requireUserId(req);
    const { week } = req.body;

    if (week === undefined || week === null) {
      throw new ValidationException('Week is required');
    }
    const weekNum = parseInt(week, 10);
    if (isNaN(weekNum) || weekNum < 1) {
      throw new ValidationException('Week must be a positive integer');
    }

    await this.matchupService.finalizeWeekMatchups(leagueId, weekNum, userId);
    res.json({ success: true, message: `Week ${weekNum} matchups finalized` });
  }

  async getScoringRules(req: AuthRequest, res: Response): Promise<void> {
    const leagueId = requireLeagueId(req);
    const userId = requireUserId(req);

    const rules = await this.scoringService.getScoringRules(leagueId, userId);
    res.json({ rules });
  }

  async calculateScores(req: AuthRequest, res: Response): Promise<void> {
    const leagueId = requireLeagueId(req);
    const userId = requireUserId(req);
    const { week } = req.body;

    if (week === undefined || week === null) {
      throw new ValidationException('Week is required');
    }
    const weekNum = parseInt(week, 10);
    if (isNaN(weekNum) || weekNum < 1) {
      throw new ValidationException('Week must be a positive integer');
    }

    const isCommissioner = await this.leagueService.isCommissioner(leagueId, userId);
    if (!isCommissioner) {
      throw new ForbiddenException('Only commissioners can manually calculate scores');
    }

    await this.scoringService.calculateWeeklyScores(leagueId, weekNum, userId);
    res.json({ success: true, message: `Scores calculated for week ${weekNum}` });
  }

  async recalculateMedian(req: AuthRequest, res: Response): Promise<void> {
    const leagueId = requireLeagueId(req);
    const userId = requireUserId(req);
    const { week } = req.body;

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

    const result = await this.medianService.recalculateWeekMedian(leagueId, weekNum, userId);

    res.json({
      success: true,
      message: `Median results recalculated for week ${weekNum}`,
      median_points: result.medianPoints,
    });
  }
}
