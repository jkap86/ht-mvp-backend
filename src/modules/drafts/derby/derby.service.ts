/**
 * Derby Service
 *
 * Core logic for derby draft order mode where teams pick their draft slot
 * in a turn-based fashion before transitioning to the actual draft.
 */

import { randomBytes } from 'crypto';
import type { Pool, PoolClient } from 'pg';
import { runInDraftTransaction } from '../../../shared/locks';
import { tryGetSocketService } from '../../../socket';
import { ForbiddenException, NotFoundException, ValidationException } from '../../../utils/exceptions';
import { logger } from '../../../config/logger.config';
import type { Draft } from '../drafts.model';
import { DraftRepository } from '../drafts.repository';
import { DraftPickAssetRepository } from '../draft-pick-asset.repository';
import { LeagueRepository } from '../../leagues/leagues.repository';
import { RosterRepository } from '../../rosters/roster.repository';
import { DerbyRepository } from './derby.repository';
import type {
  DerbySettings,
  DerbyState,
  DerbySlotPickedEvent,
  DerbyTurnChangedEvent,
  DerbyStateResponse,
} from './derby.models';
import { extractDerbySettings } from './derby.models';

/**
 * Cryptographically secure Fisher-Yates shuffle.
 */
function secureShuffleArray<T>(array: T[]): T[] {
  const result = [...array];
  for (let i = result.length - 1; i > 0; i--) {
    const range = i + 1;
    const maxUnbiased = Math.floor(0x100000000 / range) * range;

    let randomValue: number;
    do {
      const randomBuffer = randomBytes(4);
      randomValue = randomBuffer.readUInt32BE(0);
    } while (randomValue >= maxUnbiased);

    const j = randomValue % range;
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

export class DerbyService {
  constructor(
    private readonly pool: Pool,
    private readonly derbyRepo: DerbyRepository,
    private readonly draftRepo: DraftRepository,
    private readonly leagueRepo: LeagueRepository,
    private readonly rosterRepo: RosterRepository,
    private readonly pickAssetRepo?: DraftPickAssetRepository
  ) {}

  /**
   * Start derby phase for a draft.
   * Shuffles turn order, sets first picker, starts timer.
   */
  async startDerby(leagueId: number, draftId: number, userId: string): Promise<DerbyStateResponse> {
    // Validate commissioner
    const isCommissioner = await this.leagueRepo.isCommissioner(leagueId, userId);
    if (!isCommissioner) {
      throw new ForbiddenException('Only the commissioner can start derby');
    }

    let derbyState: DerbyState;
    let draft: Draft;
    let settings: DerbySettings;
    let teamCount: number;

    await runInDraftTransaction(this.pool, draftId, async (client) => {
      // Load and validate draft
      draft = (await this.draftRepo.findByIdWithClient(client, draftId))!;
      if (!draft) {
        throw new NotFoundException('Draft not found');
      }

      if (draft.leagueId !== leagueId) {
        throw new ForbiddenException('Draft does not belong to this league');
      }

      if (draft.status !== 'not_started') {
        throw new ValidationException('Can only start derby for drafts that have not started');
      }

      if (draft.phase !== 'SETUP') {
        throw new ValidationException('Draft is not in SETUP phase');
      }

      settings = extractDerbySettings(draft.settings);
      if (!settings.derbyEnabled) {
        throw new ValidationException('Derby mode is not enabled for this draft');
      }

      // Get all rosters for the league
      const rosters = await this.rosterRepo.findByLeagueIdWithClient(client, leagueId);
      teamCount = rosters.length;

      if (teamCount < 2) {
        throw new ValidationException('Need at least 2 teams to start derby');
      }

      // Shuffle turn order
      const rosterIds = rosters.map((r) => r.id);
      const shuffledOrder = secureShuffleArray(rosterIds);

      // Create initial derby state
      const deadline = new Date(Date.now() + settings.derbySlotPickTimeSeconds * 1000);
      derbyState = {
        turnOrder: shuffledOrder,
        currentTurnIndex: 0,
        currentPickerRosterId: shuffledOrder[0],
        slotPickDeadline: deadline,
        claimedSlots: {},
      };

      // Initialize derby state in database
      await this.derbyRepo.initializeDerbyState(client, draftId, derbyState);
    });

    // Emit socket events AFTER commit
    const socket = tryGetSocketService();
    const response = this.buildStateResponse(derbyState!, draft!, settings!, teamCount!);
    socket?.emitDerbyState(draftId, response);

    logger.info(`Derby started for draft ${draftId} with ${teamCount!} teams`);

    return response;
  }

  /**
   * Pick a slot during derby phase.
   */
  async pickSlot(
    leagueId: number,
    draftId: number,
    userId: string,
    slotNumber: number
  ): Promise<void> {
    let emitData: DerbySlotPickedEvent | null = null;
    let transitionedToLive = false;
    let draft: Draft;

    await runInDraftTransaction(this.pool, draftId, async (client) => {
      // Load draft and validate
      draft = (await this.draftRepo.findByIdWithClient(client, draftId))!;
      if (!draft) {
        throw new NotFoundException('Draft not found');
      }

      if (draft.leagueId !== leagueId) {
        throw new ForbiddenException('Draft does not belong to this league');
      }

      if (draft.phase !== 'DERBY') {
        throw new ValidationException('Draft is not in DERBY phase');
      }

      // Load derby state
      const state = await this.derbyRepo.getDerbyStateWithClient(client, draftId);
      if (!state) {
        throw new ValidationException('Derby state not found');
      }

      // Validate it's this user's turn
      const roster = await this.rosterRepo.findByLeagueAndUser(leagueId, userId, client);
      if (!roster) {
        throw new ForbiddenException('You are not a member of this league');
      }

      if (state.currentPickerRosterId !== roster.id) {
        throw new ValidationException('It is not your turn to pick');
      }

      const teamCount = state.turnOrder.length;

      // Validate slot number
      if (slotNumber < 1 || slotNumber > teamCount) {
        throw new ValidationException(`Slot number must be between 1 and ${teamCount}`);
      }

      // Validate slot is available
      if (state.claimedSlots[slotNumber]) {
        throw new ValidationException(`Slot ${slotNumber} has already been claimed`);
      }

      // Validate one slot per roster
      if (Object.values(state.claimedSlots).includes(roster.id)) {
        throw new ValidationException('You have already claimed a slot');
      }

      // Claim slot
      state.claimedSlots[slotNumber] = roster.id;

      // Check if derby complete
      const claimedCount = Object.keys(state.claimedSlots).length;
      if (claimedCount === teamCount) {
        // Transition to LIVE phase
        await this.transitionToLiveInternal(client, draftId, draft, state);
        transitionedToLive = true;
        emitData = {
          rosterId: roster.id,
          slotNumber,
          nextPickerRosterId: null,
          deadline: null,
          remainingSlots: [],
        };
      } else {
        // Advance to next picker
        const settings = extractDerbySettings(draft.settings);
        const newState = this.advanceToNextPicker(state, settings.derbySlotPickTimeSeconds);
        await this.derbyRepo.updateDerbyState(client, draftId, newState);
        emitData = {
          rosterId: roster.id,
          slotNumber,
          nextPickerRosterId: newState.currentPickerRosterId,
          deadline: newState.slotPickDeadline,
          remainingSlots: this.getAvailableSlots(newState, teamCount),
        };
      }
    });

    // Emit socket events AFTER commit
    const socket = tryGetSocketService();
    if (emitData) {
      socket?.emitDerbySlotPicked(draftId, emitData);
    }

    if (transitionedToLive) {
      socket?.emitDerbyPhaseTransition(draftId, { phase: 'LIVE' });
      // Also emit draft state update for clients to reload
      const updatedDraft = await this.draftRepo.findById(draftId);
      if (updatedDraft) {
        socket?.emitDraftSettingsUpdated(draftId, {
          phase: 'LIVE',
          status: updatedDraft.status,
          current_pick: updatedDraft.currentPick,
          current_round: updatedDraft.currentRound,
          current_roster_id: updatedDraft.currentRosterId,
          pick_deadline: updatedDraft.pickDeadline,
        });
      }
    }

    logger.info(`Derby slot ${slotNumber} picked in draft ${draftId}`);
  }

  /**
   * Process a timeout based on configured policy.
   * Called by derby.job.ts when deadline expires.
   */
  async processTimeout(draftId: number): Promise<void> {
    let emitData: DerbyTurnChangedEvent | DerbySlotPickedEvent | null = null;
    let transitionedToLive = false;
    let timedOutRosterId: number;

    await runInDraftTransaction(this.pool, draftId, async (client) => {
      // Load draft and validate still in derby
      const draft = await this.draftRepo.findByIdWithClient(client, draftId);
      if (!draft || draft.phase !== 'DERBY' || draft.status !== 'in_progress') {
        // Race condition: derby ended between query and lock
        return;
      }

      // Load derby state
      const state = await this.derbyRepo.getDerbyStateWithClient(client, draftId);
      if (!state) {
        return;
      }

      // Check if deadline actually expired (re-validate under lock)
      if (!state.slotPickDeadline || state.slotPickDeadline > new Date()) {
        return; // Not expired yet
      }

      timedOutRosterId = state.currentPickerRosterId;
      const settings = extractDerbySettings(draft.settings);
      const teamCount = state.turnOrder.length;

      switch (settings.derbyTimeoutPolicy) {
        case 'AUTO_RANDOM_SLOT': {
          // Assign random available slot
          const available = this.getAvailableSlots(state, teamCount);
          if (available.length === 0) {
            logger.warn(`No slots available for auto-assign in derby ${draftId}`);
            return;
          }
          const randomSlot = available[Math.floor(Math.random() * available.length)];
          state.claimedSlots[randomSlot] = state.currentPickerRosterId;

          // Check if derby complete
          const claimedCount = Object.keys(state.claimedSlots).length;
          if (claimedCount === teamCount) {
            await this.transitionToLiveInternal(client, draftId, draft, state);
            transitionedToLive = true;
            emitData = {
              rosterId: timedOutRosterId,
              slotNumber: randomSlot,
              nextPickerRosterId: null,
              deadline: null,
              remainingSlots: [],
            } as DerbySlotPickedEvent;
          } else {
            const newState = this.advanceToNextPicker(state, settings.derbySlotPickTimeSeconds);
            await this.derbyRepo.updateDerbyState(client, draftId, newState);
            emitData = {
              rosterId: timedOutRosterId,
              slotNumber: randomSlot,
              nextPickerRosterId: newState.currentPickerRosterId,
              deadline: newState.slotPickDeadline,
              remainingSlots: this.getAvailableSlots(newState, teamCount),
            } as DerbySlotPickedEvent;
          }
          break;
        }

        case 'PUSH_BACK_ONE': {
          // Move timed-out team back one position
          const newState = this.applyPushBackOne(state, settings.derbySlotPickTimeSeconds);
          await this.derbyRepo.updateDerbyState(client, draftId, newState);
          emitData = {
            currentPickerRosterId: newState.currentPickerRosterId,
            deadline: newState.slotPickDeadline!,
            reason: 'timeout_push_back',
          } as DerbyTurnChangedEvent;
          break;
        }

        case 'PUSH_TO_END': {
          // Move timed-out team to end of turn order
          const newState = this.applyPushToEnd(state, settings.derbySlotPickTimeSeconds);
          await this.derbyRepo.updateDerbyState(client, draftId, newState);
          emitData = {
            currentPickerRosterId: newState.currentPickerRosterId,
            deadline: newState.slotPickDeadline!,
            reason: 'timeout_push_end',
          } as DerbyTurnChangedEvent;
          break;
        }
      }
    });

    // Emit socket events AFTER commit
    const socket = tryGetSocketService();
    if (emitData) {
      if ('slotNumber' in emitData) {
        socket?.emitDerbySlotPicked(draftId, emitData);
      } else {
        socket?.emitDerbyTurnChanged(draftId, emitData);
      }
    }

    if (transitionedToLive) {
      socket?.emitDerbyPhaseTransition(draftId, { phase: 'LIVE' });
    }

    logger.info(`Derby timeout processed for draft ${draftId}, roster ${timedOutRosterId!}`);
  }

  /**
   * Get current derby state for a draft.
   */
  async getDerbyState(leagueId: number, draftId: number, userId: string): Promise<DerbyStateResponse> {
    // Validate membership
    const isMember = await this.leagueRepo.isUserMember(leagueId, userId);
    if (!isMember) {
      throw new ForbiddenException('You are not a member of this league');
    }

    const draft = await this.draftRepo.findById(draftId);
    if (!draft) {
      throw new NotFoundException('Draft not found');
    }

    if (draft.leagueId !== leagueId) {
      throw new ForbiddenException('Draft does not belong to this league');
    }

    const state = await this.derbyRepo.getDerbyState(draftId);
    if (!state) {
      throw new ValidationException('Derby state not found');
    }

    const settings = extractDerbySettings(draft.settings);
    return this.buildStateResponse(state, draft, settings, state.turnOrder.length);
  }

  /**
   * Transition from DERBY to LIVE phase.
   * Internal method called within transaction.
   */
  private async transitionToLiveInternal(
    client: PoolClient,
    draftId: number,
    draft: Draft,
    state: DerbyState
  ): Promise<void> {
    // Determine first picker (slot 1)
    const firstPickerRosterId = state.claimedSlots[1];
    if (!firstPickerRosterId) {
      throw new ValidationException('Slot 1 not claimed - cannot transition to live');
    }

    // Calculate pick deadline
    const pickDeadline = new Date(Date.now() + draft.pickTimeSeconds * 1000);

    // Transition via repository
    await this.derbyRepo.transitionToLive(
      client,
      draftId,
      state.claimedSlots,
      firstPickerRosterId,
      pickDeadline
    );

    // Update pick asset positions if needed
    if (this.pickAssetRepo) {
      await this.pickAssetRepo.updatePickPositions(draftId);
    }

    logger.info(`Derby complete, transitioned to LIVE for draft ${draftId}`);
  }

  /**
   * Advance to the next picker in turn order.
   */
  private advanceToNextPicker(state: DerbyState, slotPickTimeSeconds: number): DerbyState {
    // Find next roster in turn order that hasn't picked yet
    const claimedRosterIds = new Set(Object.values(state.claimedSlots));

    for (let i = 1; i < state.turnOrder.length; i++) {
      const nextIndex = (state.currentTurnIndex + i) % state.turnOrder.length;
      const nextRosterId = state.turnOrder[nextIndex];
      if (!claimedRosterIds.has(nextRosterId)) {
        return {
          ...state,
          currentTurnIndex: nextIndex,
          currentPickerRosterId: nextRosterId,
          slotPickDeadline: new Date(Date.now() + slotPickTimeSeconds * 1000),
        };
      }
    }

    // Should not reach here if derby is not complete
    throw new ValidationException('No available pickers found');
  }

  /**
   * Apply PUSH_BACK_ONE timeout policy.
   * Swap timed-out team with the next team in order.
   */
  private applyPushBackOne(state: DerbyState, slotPickTimeSeconds: number): DerbyState {
    const claimedRosterIds = new Set(Object.values(state.claimedSlots));
    const currentIndex = state.currentTurnIndex;

    // Find the next roster that hasn't picked
    let nextUnpickedIndex = -1;
    for (let i = 1; i < state.turnOrder.length; i++) {
      const checkIndex = (currentIndex + i) % state.turnOrder.length;
      if (!claimedRosterIds.has(state.turnOrder[checkIndex])) {
        nextUnpickedIndex = checkIndex;
        break;
      }
    }

    if (nextUnpickedIndex === -1) {
      // Only current picker left - just reset deadline
      return {
        ...state,
        slotPickDeadline: new Date(Date.now() + slotPickTimeSeconds * 1000),
      };
    }

    // Swap current with next unpicked
    const newTurnOrder = [...state.turnOrder];
    [newTurnOrder[currentIndex], newTurnOrder[nextUnpickedIndex]] = [
      newTurnOrder[nextUnpickedIndex],
      newTurnOrder[currentIndex],
    ];

    // The new current picker is now whoever swapped into current position
    return {
      ...state,
      turnOrder: newTurnOrder,
      currentPickerRosterId: newTurnOrder[currentIndex],
      slotPickDeadline: new Date(Date.now() + slotPickTimeSeconds * 1000),
    };
  }

  /**
   * Apply PUSH_TO_END timeout policy.
   * Move timed-out team to end of remaining turn order.
   */
  private applyPushToEnd(state: DerbyState, slotPickTimeSeconds: number): DerbyState {
    const claimedRosterIds = new Set(Object.values(state.claimedSlots));
    const currentRosterId = state.currentPickerRosterId;

    // Build new turn order: everyone except current, then current at end
    const newTurnOrder: number[] = [];
    for (const rosterId of state.turnOrder) {
      if (rosterId !== currentRosterId) {
        newTurnOrder.push(rosterId);
      }
    }
    newTurnOrder.push(currentRosterId);

    // Find first unpicked roster in new order
    let newCurrentIndex = 0;
    for (let i = 0; i < newTurnOrder.length; i++) {
      if (!claimedRosterIds.has(newTurnOrder[i])) {
        newCurrentIndex = i;
        break;
      }
    }

    return {
      ...state,
      turnOrder: newTurnOrder,
      currentTurnIndex: newCurrentIndex,
      currentPickerRosterId: newTurnOrder[newCurrentIndex],
      slotPickDeadline: new Date(Date.now() + slotPickTimeSeconds * 1000),
    };
  }

  /**
   * Get list of available (unclaimed) slots.
   */
  private getAvailableSlots(state: DerbyState, teamCount: number): number[] {
    const claimed = new Set(Object.keys(state.claimedSlots).map(Number));
    const available: number[] = [];
    for (let i = 1; i <= teamCount; i++) {
      if (!claimed.has(i)) {
        available.push(i);
      }
    }
    return available;
  }

  /**
   * Build response object for derby state.
   */
  private buildStateResponse(
    state: DerbyState,
    draft: Draft,
    settings: DerbySettings,
    teamCount: number
  ): DerbyStateResponse {
    return {
      phase: draft.phase,
      turnOrder: state.turnOrder,
      currentTurnIndex: state.currentTurnIndex,
      currentPickerRosterId: state.currentPickerRosterId,
      slotPickDeadline: state.slotPickDeadline?.toISOString() ?? null,
      claimedSlots: Object.fromEntries(
        Object.entries(state.claimedSlots).map(([k, v]) => [k, v])
      ),
      availableSlots: this.getAvailableSlots(state, teamCount),
      timeoutPolicy: settings.derbyTimeoutPolicy,
      slotPickTimeSeconds: settings.derbySlotPickTimeSeconds,
      teamCount,
    };
  }
}
