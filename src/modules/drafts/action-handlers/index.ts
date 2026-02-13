import { ValidationException } from '../../../utils/exceptions';

/**
 * Context passed to all action handlers
 */
export interface ActionContext {
  userId: string;
  leagueId: number;
  draftId: number;
  idempotencyKey?: string;
}

/**
 * Interface for draft action handlers
 */
export interface ActionHandler {
  /** List of action names this handler supports */
  readonly actions: readonly string[];

  /**
   * Handle the action
   * @param ctx - Context containing userId, leagueId, draftId
   * @param action - The action name
   * @param params - Additional parameters for the action
   * @returns The result of the action
   */
  handle(ctx: ActionContext, action: string, params: Record<string, any>): Promise<any>;
}

/**
 * Dispatcher that routes actions to the appropriate handler
 */
export class ActionDispatcher {
  private handlers: ActionHandler[] = [];

  /**
   * Register an action handler
   */
  register(handler: ActionHandler): void {
    this.handlers.push(handler);
  }

  /**
   * Dispatch an action to the appropriate handler
   * @throws ValidationException if no handler found for the action
   */
  async dispatch(ctx: ActionContext, action: string, params: Record<string, any>): Promise<any> {
    const handler = this.handlers.find((h) => h.actions.includes(action));
    if (!handler) {
      throw new ValidationException(`Unknown action: ${action}`);
    }
    return handler.handle(ctx, action, params);
  }

  /**
   * Get all registered action names
   */
  getRegisteredActions(): string[] {
    return this.handlers.flatMap((h) => [...h.actions]);
  }
}
