import { Response } from 'express';
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
  async getRosterPlayers(req: AuthRequest, res: Response): Promise<void> {
    const leagueId = requireLeagueId(req);
    const rosterId = this.requireRosterId(req);
    const userId = requireUserId(req);

    const players = await this.rosterService.getRosterPlayers(leagueId, rosterId, userId);
    res.json({ players: players.map(rosterPlayerWithDetailsToResponse) });
  }

  // POST /api/leagues/:leagueId/rosters/:rosterId/players
  async addPlayer(req: AuthRequest, res: Response): Promise<void> {
    const leagueId = requireLeagueId(req);
    const rosterId = this.requireRosterId(req);
    const userId = requireUserId(req);
    const { playerId } = req.body;
    if (typeof playerId !== 'number' || !Number.isInteger(playerId)) {
      throw new ValidationException('playerId must be an integer');
    }
    const idempotencyKey = req.headers['x-idempotency-key'] as string | undefined;

    const result = await this.rosterService.addPlayer(leagueId, rosterId, playerId, userId, idempotencyKey);
    res.status(result.cached ? 200 : 201).json({ player: result.rosterPlayer });
  }

  // DELETE /api/leagues/:leagueId/rosters/:rosterId/players/:playerId
  async dropPlayer(req: AuthRequest, res: Response): Promise<void> {
    const leagueId = requireLeagueId(req);
    const rosterId = this.requireRosterId(req);
    const playerId = parseIntParam(req.params.playerId);
    const userId = requireUserId(req);

    if (isNaN(playerId)) throw new ValidationException('Invalid player ID');

    await this.rosterService.dropPlayer(leagueId, rosterId, playerId, userId);
    res.status(204).send();
  }

  // POST /api/leagues/:leagueId/rosters/:rosterId/players/add-drop
  async addDropPlayer(req: AuthRequest, res: Response): Promise<void> {
    const leagueId = requireLeagueId(req);
    const rosterId = this.requireRosterId(req);
    const userId = requireUserId(req);
    const { addPlayerId, dropPlayerId } = req.body;
    if (typeof addPlayerId !== 'number' || !Number.isInteger(addPlayerId)) {
      throw new ValidationException('addPlayerId must be an integer');
    }
    if (typeof dropPlayerId !== 'number' || !Number.isInteger(dropPlayerId)) {
      throw new ValidationException('dropPlayerId must be an integer');
    }
    const idempotencyKey = req.headers['x-idempotency-key'] as string | undefined;

    const result = await this.rosterService.addDropPlayer(
      leagueId,
      rosterId,
      addPlayerId,
      dropPlayerId,
      userId,
      idempotencyKey
    );
    res.status(result.cached ? 200 : 201).json({ player: result.rosterPlayer });
  }

  // GET /api/leagues/:leagueId/free-agents
  async getFreeAgents(req: AuthRequest, res: Response): Promise<void> {
    const leagueId = requireLeagueId(req);
    const userId = requireUserId(req);
    const position = req.query.position as string | undefined;
    const search = req.query.search as string | undefined;
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 50, 100);
    const offset = Math.max(parseInt(req.query.offset as string, 10) || 0, 0);

    const players = await this.rosterService.getFreeAgents(
      leagueId,
      userId,
      position,
      search,
      limit,
      offset
    );
    res.json({ players: players.map(playerToResponse) });
  }

  // GET /api/leagues/:leagueId/transactions
  async getTransactions(req: AuthRequest, res: Response): Promise<void> {
    const leagueId = requireLeagueId(req);
    const userId = requireUserId(req);
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 50, 100);
    const offset = Math.max(parseInt(req.query.offset as string, 10) || 0, 0);

    const transactions = await this.rosterService.getLeagueTransactions(
      leagueId,
      userId,
      limit,
      offset
    );
    res.json({ transactions: transactions.map(rosterTransactionToResponse) });
  }

  // GET /api/leagues/:leagueId/rosters/:rosterId/lineup
  async getLineup(req: AuthRequest, res: Response): Promise<void> {
    const leagueId = requireLeagueId(req);
    const rosterId = this.requireRosterId(req);
    const userId = requireUserId(req);
    const week = parseInt(req.query.week as string, 10) || 1;

    const lineup = await this.lineupService.getLineup(leagueId, rosterId, week, userId);
    res.json({ lineup: rosterLineupToResponse(lineup) });
  }

  // PUT /api/leagues/:leagueId/rosters/:rosterId/lineup
  async setLineup(req: AuthRequest, res: Response): Promise<void> {
    const leagueId = requireLeagueId(req);
    const rosterId = this.requireRosterId(req);
    const userId = requireUserId(req);
    const { week, lineup } = req.body;
    if (typeof week !== 'number' || !Number.isInteger(week) || week < 1) {
      throw new ValidationException('week must be a positive integer');
    }
    if (!lineup || typeof lineup !== 'object') {
      throw new ValidationException('lineup must be an object');
    }

    const updatedLineup = await this.lineupService.setLineup(
      leagueId,
      rosterId,
      week,
      lineup,
      userId
    );
    res.json({ lineup: rosterLineupToResponse(updatedLineup) });
  }

  // POST /api/leagues/:leagueId/rosters/:rosterId/lineup/move
  async movePlayer(req: AuthRequest, res: Response): Promise<void> {
    const leagueId = requireLeagueId(req);
    const rosterId = this.requireRosterId(req);
    const userId = requireUserId(req);
    const { week, playerId, toSlot } = req.body;

    // Validate week range (1-18)
    if (typeof week !== 'number' || !Number.isInteger(week) || week < 1 || week > 18) {
      throw new ValidationException('Week must be between 1 and 18');
    }

    if (typeof playerId !== 'number' || !Number.isInteger(playerId)) {
      throw new ValidationException('playerId must be an integer');
    }
    if (typeof toSlot !== 'string' || !toSlot.trim()) {
      throw new ValidationException('toSlot must be a non-empty string');
    }

    const lineup = await this.lineupService.movePlayer(
      leagueId,
      rosterId,
      week,
      playerId,
      toSlot,
      userId
    );
    res.json({ lineup: rosterLineupToResponse(lineup) });
  }

  // POST /api/leagues/:leagueId/lineups/lock
  async lockLineups(req: AuthRequest, res: Response): Promise<void> {
    const leagueId = requireLeagueId(req);
    const userId = requireUserId(req);
    const { week } = req.body;

    await this.lineupService.lockLineups(leagueId, week, userId);
    res.json({ success: true });
  }
}
