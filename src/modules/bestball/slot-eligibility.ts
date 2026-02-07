/**
 * Slot eligibility utilities for bestball lineup optimization.
 * Defines which player positions can fill which lineup slots.
 */

import { PositionSlot } from '../lineups/lineups.model';

/**
 * Starter slots that count for scoring
 */
const STARTER_SLOTS: PositionSlot[] = [
  'QB',
  'RB',
  'WR',
  'TE',
  'FLEX',
  'SUPER_FLEX',
  'REC_FLEX',
  'K',
  'DEF',
  'DL',
  'LB',
  'DB',
  'IDP_FLEX',
];

/**
 * Reserve slots (never eligible for starters)
 */
const RESERVE_SLOTS: PositionSlot[] = ['BN', 'IR', 'TAXI'];

/**
 * Maps each slot to the positions eligible to fill it
 */
const SLOT_ELIGIBILITY: Record<PositionSlot, string[]> = {
  QB: ['QB'],
  RB: ['RB'],
  WR: ['WR'],
  TE: ['TE'],
  FLEX: ['RB', 'WR', 'TE'],
  SUPER_FLEX: ['QB', 'RB', 'WR', 'TE'],
  REC_FLEX: ['WR', 'TE'],
  K: ['K'],
  DEF: ['DEF'],
  DL: ['DL'],
  LB: ['LB'],
  DB: ['DB'],
  IDP_FLEX: ['DL', 'LB', 'DB'],
  BN: [],
  IR: [],
  TAXI: [],
};

/**
 * Check if a slot is a starter slot (counts for scoring)
 */
export function isStarterSlot(slot: PositionSlot): boolean {
  return STARTER_SLOTS.includes(slot);
}

/**
 * Check if a slot is a reserve slot (bench/IR/taxi)
 */
export function isReserveSlot(slot: PositionSlot): boolean {
  return RESERVE_SLOTS.includes(slot);
}

/**
 * Get the list of positions eligible for a given slot
 */
export function getEligiblePositionsForSlot(slot: PositionSlot): Set<string> {
  return new Set(SLOT_ELIGIBILITY[slot] || []);
}

/**
 * Get all starter slots
 */
export function getStarterSlotsList(): PositionSlot[] {
  return [...STARTER_SLOTS];
}

/**
 * Get all reserve slots
 */
export function getReserveSlotsList(): PositionSlot[] {
  return [...RESERVE_SLOTS];
}

/**
 * Check if a player position can fill a given slot
 */
export function canPositionFillSlot(position: string, slot: PositionSlot): boolean {
  const eligible = SLOT_ELIGIBILITY[slot];
  if (!eligible) return false;
  return eligible.includes(position);
}

/**
 * Get all slots a position can fill (including flex slots)
 */
export function getSlotsForPosition(position: string): PositionSlot[] {
  const slots: PositionSlot[] = [];
  for (const slot of STARTER_SLOTS) {
    if (canPositionFillSlot(position, slot)) {
      slots.push(slot);
    }
  }
  return slots;
}
