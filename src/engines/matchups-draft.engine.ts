import { BaseDraftEngine } from './base-draft.engine';
import type { NextPickDetails } from './draft-engine.interface';
import type { Draft, DraftOrderEntry } from '../modules/drafts/drafts.model';
import { draftToResponse } from '../modules/drafts/drafts.model';
import type { PoolClient, Pool } from 'pg';
import { ValidationException } from '../utils/exceptions';
import { container, KEYS } from '../container';
import type { RosterRepository } from '../modules/leagues/leagues.repository';
import { finalizeDraftCompletion } from '../modules/drafts/draft-completion.utils';
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

      // Count opponent frequency (single-direction per row; reciprocal rows provide the reverse)
      const opponentId = metadata.opponentRosterId;
      const key = `${rosterId}-${opponentId}`;
      opponentCounts.set(key, (opponentCounts.get(key) || 0) + 1);
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
   * Override autopick to handle matchup selection instead of player selection.
   * When a timer expires or autodraft fires, picks the first available matchup
   * (lowest week, first opponent).
   */
  protected async performAutoPickInternal(
    client: PoolClient,
    draft: Draft,
    draftOrder: DraftOrderEntry[]
  ): Promise<{ result: any; eventData: any }> {
    if (!draft.currentRosterId) {
      throw new Error('No current roster to pick for');
    }

    // Get available matchup options
    const availableMatchups = await this.getAvailableMatchups(client, draft, draftOrder);

    if (availableMatchups.length === 0) {
      throw new Error(`No available matchups for auto-pick in draft ${draft.id}`);
    }

    // Simple strategy: pick first available (lowest week, first opponent)
    const selectedMatchup = availableMatchups[0];

    // Compute next pick state
    const nextPickState = this.computeNextPickState(draft, draftOrder);

    const totalRosters = draftOrder.length;
    const pickInRound = this.getPickInRound(draft.currentPick, totalRosters);

    // Resolve matchup draft repository
    const { MatchupDraftRepository } = await import('../modules/drafts/repositories/matchup-draft.repository');
    const pool = container.resolve<Pool>(KEYS.POOL);
    const matchupDraftRepo = new MatchupDraftRepository(pool);

    // Make the pick atomically (client already holds the DRAFT lock)
    const { result } = await matchupDraftRepo.makeMatchupPickAndAdvanceTxWithClient(client, {
      draftId: draft.id,
      expectedPickNumber: draft.currentPick,
      round: draft.currentRound,
      pickInRound,
      rosterId: draft.currentRosterId,
      week: selectedMatchup.week,
      opponentRosterId: selectedMatchup.opponentRosterId,
      nextPickState,
      idempotencyKey: `autopick-matchup-${draft.id}-${draft.currentPick}`,
      isAutoPick: true,
    });

    // Handle draft completion
    if (nextPickState.status === 'completed') {
      await finalizeDraftCompletion(
        {
          draftRepo: this.draftRepo,
          leagueRepo: this.leagueRepo,
          rosterPlayersRepo: this.rosterPlayersRepo,
        },
        draft.id,
        draft.leagueId,
        client
      );
    }

    // Build next pick info for socket emission
    const nextPickInfo: NextPickDetails | null = nextPickState.status === 'completed' ? null : {
      currentPick: nextPickState.currentPick!,
      currentRound: nextPickState.currentRound!,
      currentRosterId: nextPickState.currentRosterId,
      pickDeadline: nextPickState.pickDeadline!,
      status: 'in_progress',
    };

    // Build pick payload for event emission
    const pickPayload = {
      id: result.pickId,
      draft_id: draft.id,
      pick_number: draft.currentPick,
      round: draft.currentRound,
      pick_in_round: pickInRound,
      roster_id: draft.currentRosterId,
      player_id: null,
      is_auto_pick: true,
      auto_pick_reason: 'autodraft',
      picked_at: result.pickedAt,
      week: selectedMatchup.week,
      opponent_roster_id: selectedMatchup.opponentRosterId,
      opponent_team_name: selectedMatchup.opponentTeamName,
      is_matchup: true,
    };

    // Collect completed draft data if draft completed
    let completedDraftResponse: Record<string, any> | undefined;
    if (nextPickState.status === 'completed') {
      const completedDraft = await this.draftRepo.findByIdWithClient(client, draft.id);
      if (completedDraft) {
        completedDraftResponse = draftToResponse(completedDraft);
      }
    }

    logger.info(
      `Auto-pick made in matchups draft ${draft.id}: Week ${selectedMatchup.week}, Team ${draft.currentRosterId} vs Team ${selectedMatchup.opponentRosterId}`
    );

    return {
      result,
      eventData: {
        type: 'matchup' as const,
        draftId: draft.id,
        pickPayload,
        nextPickInfo,
        completedDraftResponse,
      },
    };
  }

  /**
   * Override isDraftComplete to check if all rosters have complete schedules.
   * In matchups drafts, completion means every team has a matchup for every week.
   */
  isDraftComplete(draft: Draft, afterPickNumber: number): boolean {
    const totalTeams = draft.draftState?.totalTeams || 0;
    const totalWeeks = draft.rounds;

    // Each pick fills 2 slots (reciprocal), so picks needed = matchupsPerWeek * totalWeeks
    // For odd teams, one team has a bye each week: matchupsPerWeek = floor(totalTeams / 2)
    const matchupsPerWeek = Math.floor(totalTeams / 2);
    const requiredPicks = matchupsPerWeek * totalWeeks;

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
