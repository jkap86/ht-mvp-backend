import { Response, NextFunction } from 'express';
import { AuthRequest } from '../../middleware/auth.middleware';
import { RosterService } from './rosters.service';
import { LineupService } from '../lineups/lineups.service';
import { rosterPlayerWithDetailsToResponse, rosterTransactionToResponse } from './rosters.model';
import { rosterLineupToResponse } from '../lineups/lineups.model';
import { playerToResponse } from '../players/players.model';
import { requireUserId, requireLeagueId } from '../../utils/controller-helpers';
import { parseIntParam } from '../../utils/params';
import { ValidationException } from '../../utils/exceptions';

export class RostersController {
  constructor(
    private readonly rosterService: RosterService,
    private readonly lineupService: LineupService
  ) {
    // Bind methods to preserve 'this' context
    this.getRosterPlayers = this.getRosterPlayers.bind(this);
    this.addPlayer = this.addPlayer.bind(this);
    this.dropPlayer = this.dropPlayer.bind(this);
    this.addDropPlayer = this.addDropPlayer.bind(this);
    this.getFreeAgents = this.getFreeAgents.bind(this);
    this.getTransactions = this.getTransactions.bind(this);
    this.getLineup = this.getLineup.bind(this);
    this.setLineup = this.setLineup.bind(this);
    this.movePlayer = this.movePlayer.bind(this);
    this.lockLineups = this.lockLineups.bind(this);
  }

  private requireRosterId(req: AuthRequest): number {
    const rosterId = parseIntParam(req.params.rosterId);
    if (isNaN(rosterId)) throw new ValidationException('Invalid roster ID');
    return rosterId;
  }

  // GET /api/leagues/:leagueId/rosters/:rosterId/players
  async getRosterPlayers(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const leagueId = requireLeagueId(req);
      const rosterId = this.requireRosterId(req);
      const userId = requireUserId(req);

      const players = await this.rosterService.getRosterPlayers(leagueId, rosterId, userId);
      res.json({ players: players.map(rosterPlayerWithDetailsToResponse) });
    } catch (error) {
      next(error);
    }
  }

  // POST /api/leagues/:leagueId/rosters/:rosterId/players
  async addPlayer(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const leagueId = requireLeagueId(req);
      const rosterId = this.requireRosterId(req);
      const userId = requireUserId(req);
      const { playerId } = req.body;

      const rosterPlayer = await this.rosterService.addPlayer(leagueId, rosterId, playerId, userId);
      res.status(201).json({ player: rosterPlayer });
    } catch (error) {
      next(error);
    }
  }

  // DELETE /api/leagues/:leagueId/rosters/:rosterId/players/:playerId
  async dropPlayer(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const leagueId = requireLeagueId(req);
      const rosterId = this.requireRosterId(req);
      const playerId = parseIntParam(req.params.playerId);
      const userId = requireUserId(req);

      if (isNaN(playerId)) throw new ValidationException('Invalid player ID');

      await this.rosterService.dropPlayer(leagueId, rosterId, playerId, userId);
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  }

  // POST /api/leagues/:leagueId/rosters/:rosterId/players/add-drop
  async addDropPlayer(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const leagueId = requireLeagueId(req);
      const rosterId = this.requireRosterId(req);
      const userId = requireUserId(req);
      const { addPlayerId, dropPlayerId } = req.body;

      const rosterPlayer = await this.rosterService.addDropPlayer(
        leagueId,
        rosterId,
        addPlayerId,
        dropPlayerId,
        userId
      );
      res.status(201).json({ player: rosterPlayer });
    } catch (error) {
      next(error);
    }
  }

  // GET /api/leagues/:leagueId/free-agents
  async getFreeAgents(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const leagueId = requireLeagueId(req);
      const userId = requireUserId(req);
      const position = req.query.position as string | undefined;
      const search = req.query.search as string | undefined;
      const limit = parseInt(req.query.limit as string, 10) || 50;
      const offset = parseInt(req.query.offset as string, 10) || 0;

      const players = await this.rosterService.getFreeAgents(
        leagueId,
        userId,
        position,
        search,
        limit,
        offset
      );
      res.json({ players: players.map(playerToResponse) });
    } catch (error) {
      next(error);
    }
  }

  // GET /api/leagues/:leagueId/transactions
  async getTransactions(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const leagueId = requireLeagueId(req);
      const userId = requireUserId(req);
      const limit = parseInt(req.query.limit as string, 10) || 50;
      const offset = parseInt(req.query.offset as string, 10) || 0;

      const transactions = await this.rosterService.getLeagueTransactions(
        leagueId,
        userId,
        limit,
        offset
      );
      res.json({ transactions: transactions.map(rosterTransactionToResponse) });
    } catch (error) {
      next(error);
    }
  }

  // GET /api/leagues/:leagueId/rosters/:rosterId/lineup
  async getLineup(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const leagueId = requireLeagueId(req);
      const rosterId = this.requireRosterId(req);
      const userId = requireUserId(req);
      const week = parseInt(req.query.week as string, 10) || 1;

      const lineup = await this.lineupService.getLineup(leagueId, rosterId, week, userId);
      res.json({ lineup: rosterLineupToResponse(lineup) });
    } catch (error) {
      next(error);
    }
  }

  // PUT /api/leagues/:leagueId/rosters/:rosterId/lineup
  async setLineup(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const leagueId = requireLeagueId(req);
      const rosterId = this.requireRosterId(req);
      const userId = requireUserId(req);
      const { week, lineup } = req.body;

      const updatedLineup = await this.lineupService.setLineup(
        leagueId,
        rosterId,
        week,
        lineup,
        userId
      );
      res.json({ lineup: rosterLineupToResponse(updatedLineup) });
    } catch (error) {
      next(error);
    }
  }

  // POST /api/leagues/:leagueId/rosters/:rosterId/lineup/move
  async movePlayer(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const leagueId = requireLeagueId(req);
      const rosterId = this.requireRosterId(req);
      const userId = requireUserId(req);
      const { week, playerId, toSlot } = req.body;

      const lineup = await this.lineupService.movePlayer(
        leagueId,
        rosterId,
        week,
        playerId,
        toSlot,
        userId
      );
      res.json({ lineup: rosterLineupToResponse(lineup) });
    } catch (error) {
      next(error);
    }
  }

  // POST /api/leagues/:leagueId/lineups/lock
  async lockLineups(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const leagueId = requireLeagueId(req);
      const userId = requireUserId(req);
      const { week } = req.body;

      await this.lineupService.lockLineups(leagueId, week, userId);
      res.json({ success: true });
    } catch (error) {
      next(error);
    }
  }
}
