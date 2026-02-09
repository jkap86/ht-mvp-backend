/**
 * Draft Command Handlers
 *
 * NOTE: These handlers are PLACEHOLDERS. They are not registered with the
 * command bus until service method signatures are aligned. See handlers/index.ts.
 *
 * TODO: Implement handlers once service methods support the command pattern.
 */

import { CommandHandler } from '../command-bus';
import {
  Command,
  CommandTypes,
  DraftMakePickPayload,
  DraftMakePickAssetPayload,
  DraftAutoPickPayload,
  DraftTimeoutPayload,
  DraftStartPayload,
  DraftPausePayload,
  DraftResumePayload,
  DraftCompletePayload,
  DraftUndoPickPayload,
} from '../commands';

// Placeholder implementations - not currently registered

export class DraftMakePickHandler implements CommandHandler<DraftMakePickPayload> {
  readonly commandType = CommandTypes.DRAFT_MAKE_PICK;

  async handle(_command: Command<DraftMakePickPayload>): Promise<unknown> {
    throw new Error('Handler not implemented - use DraftPickService directly');
  }
}

export class DraftMakePickAssetHandler implements CommandHandler<DraftMakePickAssetPayload> {
  readonly commandType = CommandTypes.DRAFT_MAKE_PICK_ASSET_SELECTION;

  async handle(_command: Command<DraftMakePickAssetPayload>): Promise<unknown> {
    throw new Error('Handler not implemented - use DraftPickService directly');
  }
}

export class DraftAutoPickHandler implements CommandHandler<DraftAutoPickPayload> {
  readonly commandType = CommandTypes.DRAFT_AUTO_PICK;

  async handle(_command: Command<DraftAutoPickPayload>): Promise<unknown> {
    throw new Error('Handler not implemented - use engine tick flow');
  }
}

export class DraftTimeoutHandler implements CommandHandler<DraftTimeoutPayload> {
  readonly commandType = CommandTypes.DRAFT_TIMEOUT;

  async handle(_command: Command<DraftTimeoutPayload>): Promise<unknown> {
    throw new Error('Handler not implemented - use engine tick flow');
  }
}

export class DraftStartHandler implements CommandHandler<DraftStartPayload> {
  readonly commandType = CommandTypes.DRAFT_START;

  async handle(_command: Command<DraftStartPayload>): Promise<unknown> {
    throw new Error('Handler not implemented - use DraftStateService directly');
  }
}

export class DraftPauseHandler implements CommandHandler<DraftPausePayload> {
  readonly commandType = CommandTypes.DRAFT_PAUSE;

  async handle(_command: Command<DraftPausePayload>): Promise<unknown> {
    throw new Error('Handler not implemented - use DraftStateService directly');
  }
}

export class DraftResumeHandler implements CommandHandler<DraftResumePayload> {
  readonly commandType = CommandTypes.DRAFT_RESUME;

  async handle(_command: Command<DraftResumePayload>): Promise<unknown> {
    throw new Error('Handler not implemented - use DraftStateService directly');
  }
}

export class DraftCompleteHandler implements CommandHandler<DraftCompletePayload> {
  readonly commandType = CommandTypes.DRAFT_COMPLETE;

  async handle(_command: Command<DraftCompletePayload>): Promise<unknown> {
    throw new Error('Handler not implemented - use DraftStateService directly');
  }
}

export class DraftUndoPickHandler implements CommandHandler<DraftUndoPickPayload> {
  readonly commandType = CommandTypes.DRAFT_UNDO_PICK;

  async handle(_command: Command<DraftUndoPickPayload>): Promise<unknown> {
    throw new Error('Handler not implemented - use DraftStateService.undoPick directly');
  }
}

/**
 * Get all draft command handlers for registration.
 * NOTE: Currently returns empty array - handlers are placeholders.
 */
export function getDraftCommandHandlers(): CommandHandler[] {
  return [];
}
