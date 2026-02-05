import { ActionHandler, ActionContext } from './index';
import { DraftService } from '../drafts.service';

/**
 * Handles pick action
 * Authorization (turn checking) handled by service layer
 * Supports both player picks and pick asset selections (for vet drafts with rookie picks)
 */
export class PickActionHandler implements ActionHandler {
  readonly actions = ['pick'] as const;

  constructor(private readonly draftService: DraftService) {}

  async handle(ctx: ActionContext, action: string, params: Record<string, any>): Promise<any> {
    if (action === 'pick') {
      // Check if this is a pick asset selection or a player pick
      if (params.draftPickAssetId) {
        const result = await this.draftService.makePickAssetSelection(
          ctx.leagueId,
          ctx.draftId,
          ctx.userId,
          params.draftPickAssetId
        );
        return { ok: true, action: 'pick', data: { pick: result, isPickAsset: true } };
      }

      // Regular player pick
      const result = await this.draftService.makePick(
        ctx.leagueId,
        ctx.draftId,
        ctx.userId,
        params.playerId
      );
      return { ok: true, action: 'pick', data: { pick: result } };
    }
    throw new Error(`PickActionHandler: Unknown action ${action}`);
  }
}
