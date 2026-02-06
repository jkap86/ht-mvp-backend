/**
 * Derby Draft Order Mode Types
 *
 * Derby is a pre-draft phase where teams pick their draft slot (1..N)
 * in a turn-based fashion before transitioning to the actual draft.
 */

/** Timeout policy options for derby phase */
export type DerbyTimeoutPolicy = 'AUTO_RANDOM_SLOT' | 'PUSH_BACK_ONE' | 'PUSH_TO_END';

/** Draft phase values */
export type DraftPhase = 'SETUP' | 'DERBY' | 'LIVE';

/**
 * Derby configuration settings stored in draft.settings
 */
export interface DerbySettings {
  /** Whether derby mode is enabled for this draft */
  derbyEnabled: boolean;
  /** What happens when a team times out during slot selection */
  derbyTimeoutPolicy: DerbyTimeoutPolicy;
  /** Seconds per turn for slot selection */
  derbySlotPickTimeSeconds: number;
}

/**
 * Runtime state for derby phase stored in draft.draftState
 */
export interface DerbyState {
  /** Ordered list of roster IDs for turn taking (shuffled at start) */
  turnOrder: number[];
  /** Current turn index (0-based) into turnOrder */
  currentTurnIndex: number;
  /** The roster ID whose turn it is to pick a slot */
  currentPickerRosterId: number;
  /** Deadline for current picker to select a slot */
  slotPickDeadline: Date | null;
  /** Map of claimed slots: slotNumber -> rosterId */
  claimedSlots: Record<number, number>;
}

/**
 * Payload for derby:slot_picked socket event
 */
export interface DerbySlotPickedEvent {
  /** The roster that picked the slot */
  rosterId: number;
  /** The slot number that was picked (1-indexed) */
  slotNumber: number;
  /** The next picker's roster ID, or null if derby is complete */
  nextPickerRosterId: number | null;
  /** Deadline for next pick, or null if derby is complete */
  deadline: Date | null;
  /** Remaining available slots */
  remainingSlots: number[];
}

/**
 * Payload for derby:turn_changed socket event
 */
export interface DerbyTurnChangedEvent {
  /** The roster whose turn it now is */
  currentPickerRosterId: number;
  /** Deadline for this picker */
  deadline: Date;
  /** Reason for turn change */
  reason: 'slot_picked' | 'timeout_auto_random' | 'timeout_push_back' | 'timeout_push_end';
}

/**
 * Payload for derby:phase_transition socket event
 */
export interface DerbyPhaseTransitionEvent {
  /** The new phase */
  phase: DraftPhase;
  /** Draft order after derby completes (slot position -> roster ID) */
  draftOrder?: Array<{ position: number; rosterId: number }>;
}

/**
 * Full derby state sent to clients
 */
export interface DerbyStateResponse {
  phase: DraftPhase;
  turnOrder: number[];
  currentTurnIndex: number;
  currentPickerRosterId: number;
  slotPickDeadline: string | null;
  claimedSlots: Record<string, number>;
  availableSlots: number[];
  timeoutPolicy: DerbyTimeoutPolicy;
  slotPickTimeSeconds: number;
  teamCount: number;
}

/**
 * Default derby settings
 */
export const DEFAULT_DERBY_SETTINGS: DerbySettings = {
  derbyEnabled: false,
  derbyTimeoutPolicy: 'AUTO_RANDOM_SLOT',
  derbySlotPickTimeSeconds: 60,
};

/**
 * Extract derby settings from draft settings
 */
export function extractDerbySettings(settings: Record<string, any>): DerbySettings {
  return {
    derbyEnabled: settings.derbyEnabled ?? DEFAULT_DERBY_SETTINGS.derbyEnabled,
    derbyTimeoutPolicy: settings.derbyTimeoutPolicy ?? DEFAULT_DERBY_SETTINGS.derbyTimeoutPolicy,
    derbySlotPickTimeSeconds:
      settings.derbySlotPickTimeSeconds ?? DEFAULT_DERBY_SETTINGS.derbySlotPickTimeSeconds,
  };
}

/**
 * Extract derby state from draft state
 */
export function extractDerbyState(draftState: Record<string, any>): DerbyState | null {
  if (!draftState.turnOrder) {
    return null;
  }
  return {
    turnOrder: draftState.turnOrder,
    currentTurnIndex: draftState.currentTurnIndex ?? 0,
    currentPickerRosterId: draftState.currentPickerRosterId,
    slotPickDeadline: draftState.slotPickDeadline ? new Date(draftState.slotPickDeadline) : null,
    claimedSlots: draftState.claimedSlots ?? {},
  };
}
