import type { RosterRepository, LeagueRepository } from '../leagues/leagues.repository';
import type { Roster } from '../leagues/leagues.model';
import { ForbiddenException } from '../../utils/exceptions';

/**
 * AuthorizationService provides centralized authorization checks
 * to reduce code duplication across controllers, services, and use-cases.
 */
export class AuthorizationService {
  constructor(
    private readonly rosterRepo: RosterRepository,
    private readonly leagueRepo: LeagueRepository
  ) {}

  /**
   * Ensures the user is a member of the specified league.
   * Returns the user's roster if they are a member.
   * @throws ForbiddenException if user is not a member
   */
  async ensureLeagueMember(leagueId: number, userId: string): Promise<Roster> {
    const roster = await this.rosterRepo.findByLeagueAndUser(leagueId, userId);
    if (!roster) {
      throw new ForbiddenException('You are not a member of this league');
    }
    return roster;
  }

  /**
   * Ensures the user is the commissioner of the specified league.
   * Returns the user's roster if they are the commissioner.
   * @throws ForbiddenException if user is not the commissioner
   */
  async ensureCommissioner(leagueId: number, userId: string): Promise<Roster> {
    const roster = await this.ensureLeagueMember(leagueId, userId);
    const isCommissioner = await this.leagueRepo.isCommissioner(leagueId, userId);
    if (!isCommissioner) {
      throw new ForbiddenException('Only the commissioner can perform this action');
    }
    return roster;
  }

  /**
   * Checks if the user is a member of the league (non-throwing version).
   * Returns the roster if member, null otherwise.
   */
  async getLeagueMembership(leagueId: number, userId: string): Promise<Roster | null> {
    return this.rosterRepo.findByLeagueAndUser(leagueId, userId);
  }

  /**
   * Checks if user is a member of the league (returns boolean).
   * Useful for socket handlers or optional membership checks.
   */
  async isLeagueMember(leagueId: number, userId: string): Promise<boolean> {
    return this.leagueRepo.isUserMember(leagueId, userId);
  }

  /**
   * Checks if user is the commissioner (returns boolean).
   */
  async isCommissioner(leagueId: number, userId: string): Promise<boolean> {
    return this.leagueRepo.isCommissioner(leagueId, userId);
  }
}
