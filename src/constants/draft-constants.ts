/**
 * Draft-related constants.
 * Use these instead of hardcoded strings for type safety and consistency.
 */

export const DRAFT_STATUS = {
  NOT_STARTED: 'not_started',
  IN_PROGRESS: 'in_progress',
  PAUSED: 'paused',
  COMPLETED: 'completed',
} as const;

export type DraftStatus = typeof DRAFT_STATUS[keyof typeof DRAFT_STATUS];

export const DRAFT_TYPE = {
  SNAKE: 'snake',
  LINEAR: 'linear',
  AUCTION: 'auction',
} as const;

export type DraftType = typeof DRAFT_TYPE[keyof typeof DRAFT_TYPE];
