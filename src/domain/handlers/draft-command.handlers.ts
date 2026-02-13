/**
 * Draft Command Handlers
 *
 * Wires draft commands to DraftStateService and DraftPickService.
 */

import { CommandHandler } from '../command-bus';
import {
  Command,
  CommandTypes,
  DraftMakePickPayload,
  DraftMakePickAssetPayload,
  DraftStartPayload,
  DraftPausePayload,
  DraftResumePayload,
  DraftCompletePayload,
  DraftUndoPickPayload,
} from '../commands';
import { container, KEYS } from '../../container';
import type { DraftPickService } from '../../modules/drafts/draft-pick.service';
import type { DraftStateService } from '../../modules/drafts/draft-state.service';

export class DraftMakePickHandler implements CommandHandler<DraftMakePickPayload> {
  readonly commandType = CommandTypes.DRAFT_MAKE_PICK;

  async handle(command: Command<DraftMakePickPayload>): Promise<unknown> {
    const { leagueId, draftId, playerId } = command.payload;
    const userId = command.actor.userId;
    if (!userId) throw new Error('Draft make pick requires a user actor');

    const pickService = container.resolve<DraftPickService>(KEYS.DRAFT_PICK_SERVICE);
    return pickService.makePick(leagueId, draftId, userId, playerId, command.metadata?.idempotencyKey);
  }
}

export class DraftMakePickAssetHandler implements CommandHandler<DraftMakePickAssetPayload> {
  readonly commandType = CommandTypes.DRAFT_MAKE_PICK_ASSET_SELECTION;

  async handle(command: Command<DraftMakePickAssetPayload>): Promise<unknown> {
    const { leagueId, draftId, draftPickAssetId } = command.payload;
    const userId = command.actor.userId;
    if (!userId) throw new Error('Draft make pick asset requires a user actor');

    const pickService = container.resolve<DraftPickService>(KEYS.DRAFT_PICK_SERVICE);
    return pickService.makePickAssetSelection(leagueId, draftId, userId, draftPickAssetId, command.metadata?.idempotencyKey);
  }
}

export class DraftStartHandler implements CommandHandler<DraftStartPayload> {
  readonly commandType = CommandTypes.DRAFT_START;

  async handle(command: Command<DraftStartPayload>): Promise<unknown> {
    const { draftId } = command.payload;
    const userId = command.actor.userId;
    if (!userId) throw new Error('Draft start requires a user actor');

    const stateService = container.resolve<DraftStateService>(KEYS.DRAFT_STATE_SERVICE);
    return stateService.startDraft(draftId, userId, command.metadata?.idempotencyKey);
  }
}

export class DraftPauseHandler implements CommandHandler<DraftPausePayload> {
  readonly commandType = CommandTypes.DRAFT_PAUSE;

  async handle(command: Command<DraftPausePayload>): Promise<unknown> {
    const { draftId } = command.payload;
    const userId = command.actor.userId;
    if (!userId) throw new Error('Draft pause requires a user actor');

    const stateService = container.resolve<DraftStateService>(KEYS.DRAFT_STATE_SERVICE);
    return stateService.pauseDraft(draftId, userId, command.metadata?.idempotencyKey);
  }
}

export class DraftResumeHandler implements CommandHandler<DraftResumePayload> {
  readonly commandType = CommandTypes.DRAFT_RESUME;

  async handle(command: Command<DraftResumePayload>): Promise<unknown> {
    const { draftId } = command.payload;
    const userId = command.actor.userId;
    if (!userId) throw new Error('Draft resume requires a user actor');

    const stateService = container.resolve<DraftStateService>(KEYS.DRAFT_STATE_SERVICE);
    return stateService.resumeDraft(draftId, userId, command.metadata?.idempotencyKey);
  }
}

export class DraftCompleteHandler implements CommandHandler<DraftCompletePayload> {
  readonly commandType = CommandTypes.DRAFT_COMPLETE;

  async handle(command: Command<DraftCompletePayload>): Promise<unknown> {
    const { draftId } = command.payload;
    const userId = command.actor.userId;
    if (!userId) throw new Error('Draft complete requires a user actor');

    const stateService = container.resolve<DraftStateService>(KEYS.DRAFT_STATE_SERVICE);
    return stateService.completeDraft(draftId, userId, command.metadata?.idempotencyKey);
  }
}

export class DraftUndoPickHandler implements CommandHandler<DraftUndoPickPayload> {
  readonly commandType = CommandTypes.DRAFT_UNDO_PICK;

  async handle(command: Command<DraftUndoPickPayload>): Promise<unknown> {
    const { leagueId, draftId } = command.payload;
    const userId = command.actor.userId;
    if (!userId) throw new Error('Draft undo pick requires a user actor');

    const stateService = container.resolve<DraftStateService>(KEYS.DRAFT_STATE_SERVICE);
    return stateService.undoPick(leagueId, draftId, userId);
  }
}

/**
 * Get all draft command handlers for registration.
 */
export function getDraftCommandHandlers(): CommandHandler[] {
  return [
    new DraftMakePickHandler(),
    new DraftMakePickAssetHandler(),
    new DraftStartHandler(),
    new DraftPauseHandler(),
    new DraftResumeHandler(),
    new DraftCompleteHandler(),
    new DraftUndoPickHandler(),
  ];
}
