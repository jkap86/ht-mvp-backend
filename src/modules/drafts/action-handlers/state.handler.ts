import { ActionHandler, ActionContext } from './index';
import { DraftService } from '../drafts.service';

/**
 * Handles draft state actions: start, pause, resume, complete
 * These are commissioner-only actions (authorization handled by service layer)
 */
export class StateActionHandler implements ActionHandler {
  readonly actions = ['start', 'pause', 'resume', 'complete'] as const;

  constructor(private readonly draftService: DraftService) {}

  async handle(
    ctx: ActionContext,
    action: string,
    _params: Record<string, any>
  ): Promise<any> {
    switch (action) {
      case 'start':
        return this.draftService.startDraft(ctx.draftId, ctx.userId);
      case 'pause':
        return this.draftService.pauseDraft(ctx.draftId, ctx.userId);
      case 'resume':
        return this.draftService.resumeDraft(ctx.draftId, ctx.userId);
      case 'complete':
        return this.draftService.completeDraft(ctx.draftId, ctx.userId);
      default:
        throw new Error(`StateActionHandler: Unknown action ${action}`);
    }
  }
}
