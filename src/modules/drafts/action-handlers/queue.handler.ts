import { ActionHandler, ActionContext } from './index';
import { DraftQueueService } from '../draft-queue.service';
import { RosterRepository } from '../../leagues/leagues.repository';
import { ForbiddenException } from '../../../utils/exceptions';

/**
 * Handles queue actions: queue_add, queue_remove, queue_reorder
 * Requires league membership (roster lookup)
 */
export class QueueActionHandler implements ActionHandler {
  readonly actions = ['queue_add', 'queue_remove', 'queue_reorder'] as const;

  constructor(
    private readonly queueService: DraftQueueService,
    private readonly rosterRepo: RosterRepository
  ) {}

  async handle(
    ctx: ActionContext,
    action: string,
    params: Record<string, any>
  ): Promise<any> {
    // Get user's roster for this league
    const roster = await this.rosterRepo.findByLeagueAndUser(ctx.leagueId, ctx.userId);
    if (!roster) {
      throw new ForbiddenException('You are not a member of this league');
    }

    switch (action) {
      case 'queue_add':
        return this.queueService.addToQueue(ctx.draftId, roster.id, params.playerId);

      case 'queue_remove':
        await this.queueService.removeFromQueueByPlayer(ctx.draftId, roster.id, params.playerId);
        return { success: true };

      case 'queue_reorder':
        await this.queueService.reorderQueue(ctx.draftId, roster.id, params.playerIds);
        return { success: true };

      default:
        throw new Error(`QueueActionHandler: Unknown action ${action}`);
    }
  }
}
