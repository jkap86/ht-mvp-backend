import { ActionHandler, ActionContext } from './index';
import { DraftService } from '../drafts.service';

/**
 * Handles draft state actions: start, pause, resume, complete
 * These are commissioner-only actions (authorization handled by service layer)
 */
export class StateActionHandler implements ActionHandler {
  readonly actions = ['start', 'pause', 'resume', 'complete'] as const;

  constructor(private readonly draftService: DraftService) {}

  async handle(ctx: ActionContext, action: string, _params: Record<string, any>): Promise<any> {
    switch (action) {
      case 'start': {
        const result = await this.draftService.startDraft(ctx.draftId, ctx.userId);
        return { ok: true, action: 'start', data: { draft: result } };
      }
      case 'pause': {
        const result = await this.draftService.pauseDraft(ctx.draftId, ctx.userId);
        return { ok: true, action: 'pause', data: { draft: result } };
      }
      case 'resume': {
        const result = await this.draftService.resumeDraft(ctx.draftId, ctx.userId);
        return { ok: true, action: 'resume', data: { draft: result } };
      }
      case 'complete': {
        const result = await this.draftService.completeDraft(ctx.draftId, ctx.userId);
        return { ok: true, action: 'complete', data: { draft: result } };
      }
      default:
        throw new Error(`StateActionHandler: Unknown action ${action}`);
    }
  }
}
