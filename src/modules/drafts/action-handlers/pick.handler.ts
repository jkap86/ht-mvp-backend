import { ActionHandler, ActionContext } from './index';
import { DraftService } from '../drafts.service';

/**
 * Handles pick action
 * Authorization (turn checking) handled by service layer
 */
export class PickActionHandler implements ActionHandler {
  readonly actions = ['pick'] as const;

  constructor(private readonly draftService: DraftService) {}

  async handle(
    ctx: ActionContext,
    action: string,
    params: Record<string, any>
  ): Promise<any> {
    if (action === 'pick') {
      return this.draftService.makePick(
        ctx.leagueId,
        ctx.draftId,
        ctx.userId,
        params.playerId
      );
    }
    throw new Error(`PickActionHandler: Unknown action ${action}`);
  }
}
