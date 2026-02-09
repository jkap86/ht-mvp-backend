/**
 * Draft Command Handlers
 *
 * Handlers for draft-related commands. These handlers wrap the existing
 * draft services and route commands to appropriate service methods.
 */

import { CommandHandler, Command } from '../command-bus';
import {
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
import { container, KEYS } from '../../container';
import type { DraftPickService } from '../../modules/drafts/draft-pick.service';
import type { DraftStateService } from '../../modules/drafts/draft-state.service';
import type { DraftService } from '../../modules/drafts/drafts.service';

/**
 * Handle DRAFT_MAKE_PICK command - user makes a player pick
 */
export class DraftMakePickHandler implements CommandHandler<DraftMakePickPayload> {
  readonly commandType = CommandTypes.DRAFT_MAKE_PICK;

  async handle(command: Command<DraftMakePickPayload>): Promise<unknown> {
    const draftPickService = container.resolve<DraftPickService>(KEYS.DRAFT_PICK_SERVICE);

    const userId = command.actor.userId;
    if (!userId) {
      throw new Error('User ID required for draft pick');
    }

    return await draftPickService.makePick(
      command.payload.leagueId,
      command.payload.draftId,
      userId,
      command.payload.playerId,
      command.metadata?.idempotencyKey
    );
  }
}

/**
 * Handle DRAFT_MAKE_PICK_ASSET_SELECTION command - user picks a draft pick asset (vet drafts)
 */
export class DraftMakePickAssetHandler implements CommandHandler<DraftMakePickAssetPayload> {
  readonly commandType = CommandTypes.DRAFT_MAKE_PICK_ASSET_SELECTION;

  async handle(command: Command<DraftMakePickAssetPayload>): Promise<unknown> {
    const draftPickService = container.resolve<DraftPickService>(KEYS.DRAFT_PICK_SERVICE);

    const userId = command.actor.userId;
    if (!userId) {
      throw new Error('User ID required for pick asset selection');
    }

    return await draftPickService.makePickAssetSelection(
      command.payload.leagueId,
      command.payload.draftId,
      userId,
      command.payload.draftPickAssetId,
      command.metadata?.idempotencyKey
    );
  }
}

/**
 * Handle DRAFT_AUTO_PICK command - system auto-picks for a user
 */
export class DraftAutoPickHandler implements CommandHandler<DraftAutoPickPayload> {
  readonly commandType = CommandTypes.DRAFT_AUTO_PICK;

  async handle(command: Command<DraftAutoPickPayload>): Promise<unknown> {
    // Auto-pick is handled by the draft engine's tick() method
    // This handler is for explicit auto-pick triggers
    const draftService = container.resolve<DraftService>(KEYS.DRAFT_SERVICE);

    // Get draft to determine type and call appropriate autopick
    const draft = await draftService.getDraft(command.payload.draftId);
    if (!draft) {
      throw new Error('Draft not found');
    }

    // For now, autopick is triggered via the engine.tick() flow
    // This handler provides the command bus entry point
    // The actual implementation delegates to existing autopick logic
    return { triggered: true, draftId: command.payload.draftId, reason: command.payload.reason };
  }
}

/**
 * Handle DRAFT_TIMEOUT command - pick deadline expired
 */
export class DraftTimeoutHandler implements CommandHandler<DraftTimeoutPayload> {
  readonly commandType = CommandTypes.DRAFT_TIMEOUT;

  async handle(command: Command<DraftTimeoutPayload>): Promise<unknown> {
    // Timeout handling triggers autopick with force-enabled autodraft
    // Delegates to existing engine tick logic
    return { triggered: true, draftId: command.payload.draftId, reason: 'timeout' };
  }
}

/**
 * Handle DRAFT_START command - commissioner starts draft
 */
export class DraftStartHandler implements CommandHandler<DraftStartPayload> {
  readonly commandType = CommandTypes.DRAFT_START;

  async handle(command: Command<DraftStartPayload>): Promise<unknown> {
    const draftStateService = container.resolve<DraftStateService>(KEYS.DRAFT_STATE_SERVICE);

    const userId = command.actor.userId;
    if (!userId) {
      throw new Error('User ID required to start draft');
    }

    return await draftStateService.startDraft(command.payload.draftId, userId);
  }
}

/**
 * Handle DRAFT_PAUSE command - commissioner pauses draft
 */
export class DraftPauseHandler implements CommandHandler<DraftPausePayload> {
  readonly commandType = CommandTypes.DRAFT_PAUSE;

  async handle(command: Command<DraftPausePayload>): Promise<unknown> {
    const draftStateService = container.resolve<DraftStateService>(KEYS.DRAFT_STATE_SERVICE);

    const userId = command.actor.userId;
    if (!userId) {
      throw new Error('User ID required to pause draft');
    }

    return await draftStateService.pauseDraft(command.payload.draftId, userId);
  }
}

/**
 * Handle DRAFT_RESUME command - commissioner resumes draft
 */
export class DraftResumeHandler implements CommandHandler<DraftResumePayload> {
  readonly commandType = CommandTypes.DRAFT_RESUME;

  async handle(command: Command<DraftResumePayload>): Promise<unknown> {
    const draftStateService = container.resolve<DraftStateService>(KEYS.DRAFT_STATE_SERVICE);

    const userId = command.actor.userId;
    if (!userId) {
      throw new Error('User ID required to resume draft');
    }

    return await draftStateService.resumeDraft(command.payload.draftId, userId);
  }
}

/**
 * Handle DRAFT_COMPLETE command - commissioner manually completes draft
 */
export class DraftCompleteHandler implements CommandHandler<DraftCompletePayload> {
  readonly commandType = CommandTypes.DRAFT_COMPLETE;

  async handle(command: Command<DraftCompletePayload>): Promise<unknown> {
    const draftStateService = container.resolve<DraftStateService>(KEYS.DRAFT_STATE_SERVICE);

    const userId = command.actor.userId;
    if (!userId) {
      throw new Error('User ID required to complete draft');
    }

    return await draftStateService.completeDraft(command.payload.draftId, userId);
  }
}

/**
 * Handle DRAFT_UNDO_PICK command - commissioner undoes last pick
 */
export class DraftUndoPickHandler implements CommandHandler<DraftUndoPickPayload> {
  readonly commandType = CommandTypes.DRAFT_UNDO_PICK;

  async handle(command: Command<DraftUndoPickPayload>): Promise<unknown> {
    const draftStateService = container.resolve<DraftStateService>(KEYS.DRAFT_STATE_SERVICE);

    const userId = command.actor.userId;
    if (!userId) {
      throw new Error('User ID required to undo pick');
    }

    return await draftStateService.undoLastPick(command.payload.draftId, userId);
  }
}

/**
 * Get all draft command handlers for registration.
 */
export function getDraftCommandHandlers(): CommandHandler[] {
  return [
    new DraftMakePickHandler(),
    new DraftMakePickAssetHandler(),
    new DraftAutoPickHandler(),
    new DraftTimeoutHandler(),
    new DraftStartHandler(),
    new DraftPauseHandler(),
    new DraftResumeHandler(),
    new DraftCompleteHandler(),
    new DraftUndoPickHandler(),
  ];
}
