import { BaseDraftEngine } from './base-draft.engine';
import type { Draft, DraftOrderEntry } from '../modules/drafts/drafts.model';
import type { PoolClient } from 'pg';
import { ValidationException } from '../utils/exceptions';
import { container, KEYS } from '../container';
import type { RosterRepository } from '../modules/leagues/leagues.repository';
import { logger } from '../config/logger.config';

/**
 * Matchups draft engine for strategic schedule building.
 *
 * In matchups drafts, managers draft which week they play which opponent,
 * instead of drafting players. Uses snake order for fairness.
 *
 * Key behaviors:
 * - Pool consists of week/opponent combinations
 * - When Team A picks "Week 3 vs Team B", both teams get that matchup (reciprocal)
 * - Constraint validation ensures valid schedules (opponent frequency limits)
 * - On completion, draft picks are transformed into matchups table entries
 *
 * LOCK CONTRACT:
 * Inherits from BaseDraftEngine. No additional locks acquired.
 * All lock acquisition happens in the base class (DRAFT lock via runInDraftTransaction).
 */
export class MatchupsDraftEngine extends BaseDraftEngine {
  readonly draftType = 'matchups';

  /**
   * Get the roster that should pick at a given pick number.
   * For matchups drafts, use snake draft order (even rounds reversed).
   */
  getPickerForPickNumber(
    draft: Draft,
    draftOrder: DraftOrderEntry[],
    pickNumber: number
  ): DraftOrderEntry | undefined {
    // Defensive assertion: validate draftOrder is sorted by draftPosition
    if (draftOrder.length > 1) {
      const isSorted = draftOrder.every(
        (o, i) => i === 0 || o.draftPosition > draftOrder[i - 1].draftPosition
      );
      if (!isSorted) {
        throw new Error('draftOrder must be sorted by draftPosition');
      }
    }

    const totalRosters = draftOrder.length;
    const round = this.getRound(pickNumber, totalRosters);
    const pickInRound = this.getPickInRound(pickNumber, totalRosters);

    // Snake draft: reverse order in even rounds
    const isReversed = round % 2 === 0;
    const position = isReversed ? totalRosters - pickInRound + 1 : pickInRound;

    return draftOrder.find((o) => o.draftPosition === position);
  }

  /**
   * Calculate the maximum number of times two teams should play each other.
   * Based on league size and number of weeks.
   */
  calculateMaxOpponentFrequency(totalTeams: number, totalWeeks: number): number {
    if (totalTeams < 2) return 0;

    // Each team plays (totalWeeks) games
    // Against (totalTeams - 1) possible opponents
    // Max times vs any single opponent = ceil(totalWeeks / (totalTeams - 1))
    return Math.ceil(totalWeeks / (totalTeams - 1));
  }

  /**
   * Get all available matchup options for the current picker.
   * Filters out invalid combinations based on constraints.
   *
   * @param client - Database client for transaction consistency
   * @param draft - The matchups draft
   * @param draftOrder - Draft order entries
   * @returns Array of available matchup options with metadata
   */
  async getAvailableMatchups(
    client: PoolClient,
    draft: Draft,
    draftOrder: DraftOrderEntry[]
  ): Promise<MatchupDraftOption[]> {
    if (!draft.currentRosterId) {
      return [];
    }

    const currentPicker = draft.currentRosterId;
    const totalWeeks = draft.rounds; // In matchups draft, rounds = weeks
    const totalTeams = draftOrder.length;
    const maxOpponentFrequency = this.calculateMaxOpponentFrequency(totalTeams, totalWeeks);

    // Get all existing matchup picks for this draft
    const picksResult = await client.query(
      `SELECT roster_id, pick_metadata FROM draft_picks WHERE draft_id = $1 AND pick_metadata IS NOT NULL`,
      [draft.id]
    );

    // Build maps of: rosterId -> set of filled weeks, and opponent frequency
    const filledWeeks = new Map<number, Set<number>>();
    const opponentCounts = new Map<string, number>(); // key: "rosterId1-rosterId2"

    for (const row of picksResult.rows) {
      const rosterId = row.roster_id;
      const metadata = row.pick_metadata as { week: number; opponentRosterId: number };

      if (!filledWeeks.has(rosterId)) {
        filledWeeks.set(rosterId, new Set());
      }
      filledWeeks.get(rosterId)!.add(metadata.week);

      // Count opponent frequency (bidirectional)
      const opponentId = metadata.opponentRosterId;
      const key1 = `${rosterId}-${opponentId}`;
      const key2 = `${opponentId}-${rosterId}`;
      opponentCounts.set(key1, (opponentCounts.get(key1) || 0) + 1);
      opponentCounts.set(key2, (opponentCounts.get(key2) || 0) + 1);
    }

    // Get roster info for team names
    const rosterRepo = container.resolve<RosterRepository>(KEYS.ROSTER_REPO);
    const rosters = await rosterRepo.findByIdsWithClient(
      client,
      draftOrder.map(o => o.rosterId)
    );
    const rosterMap = new Map(rosters.map((r) => [r.id, r]));

    // Generate all valid matchup options
    const options: MatchupDraftOption[] = [];
    const currentPickerWeeks = filledWeeks.get(currentPicker) || new Set();

    for (let week = 1; week <= totalWeeks; week++) {
      // Skip weeks already filled for current picker
      if (currentPickerWeeks.has(week)) {
        continue;
      }

      // Check each potential opponent
      for (const entry of draftOrder) {
        const opponentId = entry.rosterId;

        // Can't play yourself
        if (opponentId === currentPicker) {
          continue;
        }

        // Check if opponent's week is already filled
        const opponentWeeks = filledWeeks.get(opponentId) || new Set();
        if (opponentWeeks.has(week)) {
          continue;
        }

        // Check opponent frequency limit
        const freqKey = `${currentPicker}-${opponentId}`;
        const currentFreq = opponentCounts.get(freqKey) || 0;
        if (currentFreq >= maxOpponentFrequency) {
          continue;
        }

        // Valid matchup option
        const opponentRoster = rosterMap.get(opponentId);
        const opponentTeamName = opponentRoster?.settings?.team_name || `Team ${opponentId}`;

        options.push({
          week,
          opponentRosterId: opponentId,
          opponentTeamName,
          currentFrequency: currentFreq,
          maxFrequency: maxOpponentFrequency,
        });
      }
    }

    return options;
  }

  /**
   * Validate that a matchup selection is allowed.
   * Throws ValidationException if invalid.
   */
  async validateMatchupSelection(
    client: PoolClient,
    draft: Draft,
    draftOrder: DraftOrderEntry[],
    rosterId: number,
    week: number,
    opponentRosterId: number
  ): Promise<void> {
    // Basic validation
    if (week < 1 || week > draft.rounds) {
      throw new ValidationException(`Invalid week: ${week}`);
    }

    if (rosterId === opponentRosterId) {
      throw new ValidationException('Cannot play yourself');
    }

    // Get available matchups and check if this one is in the list
    const availableMatchups = await this.getAvailableMatchups(client, draft, draftOrder);
    const isValid = availableMatchups.some(
      m => m.week === week && m.opponentRosterId === opponentRosterId
    );

    if (!isValid) {
      throw new ValidationException(
        `Matchup Week ${week} vs Opponent ${opponentRosterId} is not available`
      );
    }
  }

  /**
   * Override isDraftComplete to check if all rosters have complete schedules.
   * In matchups drafts, completion means every team has a matchup for every week.
   */
  isDraftComplete(draft: Draft, afterPickNumber: number): boolean {
    const totalTeams = draft.draftState?.totalTeams || 0;
    const totalWeeks = draft.rounds;

    // Total picks needed = totalTeams * totalWeeks (but each pick fills 2 slots reciprocally)
    // So actual picks needed = (totalTeams * totalWeeks) / 2
    const requiredPicks = (totalTeams * totalWeeks) / 2;

    return afterPickNumber >= requiredPicks;
  }
}

/**
 * Matchup draft option - a week/opponent combination available for selection
 */
export interface MatchupDraftOption {
  week: number;
  opponentRosterId: number;
  opponentTeamName: string;
  currentFrequency: number;  // How many times current picker has played this opponent
  maxFrequency: number;      // Max allowed times vs same opponent
}
