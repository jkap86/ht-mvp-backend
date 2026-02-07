import { logger } from '../../config/env.config';

/**
 * Represents a domain event that can be published and subscribed to.
 * Events are decoupled from transport (Socket.IO, webhooks, etc.).
 */
export interface DomainEvent {
  /** Event type identifier (e.g., 'draft:pick', 'trade:accepted') */
  type: string;
  /** League ID for room-based routing (optional) */
  leagueId?: number;
  /** Roster ID for user-specific routing (optional) */
  rosterId?: number;
  /** User ID for user-specific routing (optional) */
  userId?: string;
  /** Event payload data */
  payload: Record<string, unknown>;
  /** Timestamp when event was created */
  timestamp: Date;
}

/**
 * Subscriber interface for handling domain events.
 */
export interface DomainEventSubscriber {
  handle(event: DomainEvent): void | Promise<void>;
}

/**
 * Thread-local transaction context for event queuing.
 * Tracks pending events per async context.
 */
interface TransactionContext {
  pendingEvents: DomainEvent[];
}

/**
 * DomainEventBus provides a decoupled way to publish events from domain logic.
 *
 * Key features:
 * - Transaction awareness: events can be queued during a transaction and
 *   dispatched only after commit (prevents socket emits before DB commit)
 * - Multiple subscribers: Socket.IO, webhooks, logging, etc.
 * - Decoupling: Domain services don't depend on transport layer
 *
 * Usage:
 * ```typescript
 * // In domain service
 * eventBus.beginTransaction();
 * try {
 *   // Do database work...
 *   eventBus.publish({ type: 'trade:accepted', leagueId, payload });
 *   await client.query('COMMIT');
 *   eventBus.commitTransaction();
 * } catch (error) {
 *   await client.query('ROLLBACK');
 *   eventBus.rollbackTransaction();
 * }
 * ```
 */
export class DomainEventBus {
  private subscribers: DomainEventSubscriber[] = [];

  /**
   * Transaction contexts keyed by a unique ID.
   * In a real implementation, this would use AsyncLocalStorage for proper
   * async context tracking. For now, we use a simple stack approach.
   */
  private transactionStack: TransactionContext[] = [];

  /**
   * Register a subscriber to receive all published events.
   */
  subscribe(subscriber: DomainEventSubscriber): void {
    this.subscribers.push(subscriber);
  }

  /**
   * Unsubscribe a previously registered subscriber.
   */
  unsubscribe(subscriber: DomainEventSubscriber): void {
    const index = this.subscribers.indexOf(subscriber);
    if (index !== -1) {
      this.subscribers.splice(index, 1);
    }
  }

  /**
   * Publish an event. If in a transaction, queues until commit.
   * Otherwise, dispatches immediately.
   */
  publish(event: Omit<DomainEvent, 'timestamp'>): void {
    const fullEvent: DomainEvent = {
      ...event,
      timestamp: new Date(),
    };

    const currentTx = this.getCurrentTransaction();
    if (currentTx) {
      currentTx.pendingEvents.push(fullEvent);
    } else {
      this.dispatch(fullEvent);
    }
  }

  /**
   * Begin a new transaction context.
   * Events published after this will be queued until commit/rollback.
   */
  beginTransaction(): void {
    this.transactionStack.push({ pendingEvents: [] });
  }

  /**
   * Commit the current transaction, dispatching all queued events.
   */
  commitTransaction(): void {
    const tx = this.transactionStack.pop();
    if (!tx) {
      logger.warn('commitTransaction called without active transaction');
      return;
    }

    // Dispatch all queued events
    for (const event of tx.pendingEvents) {
      this.dispatch(event);
    }
  }

  /**
   * Rollback the current transaction, discarding all queued events.
   */
  rollbackTransaction(): void {
    const tx = this.transactionStack.pop();
    if (!tx) {
      logger.warn('rollbackTransaction called without active transaction');
      return;
    }
    // Events are discarded (not dispatched)
  }

  /**
   * Check if currently in a transaction.
   */
  isInTransaction(): boolean {
    return this.transactionStack.length > 0;
  }

  /**
   * Get the number of pending events in the current transaction.
   */
  getPendingEventCount(): number {
    const tx = this.getCurrentTransaction();
    return tx?.pendingEvents.length ?? 0;
  }

  private getCurrentTransaction(): TransactionContext | undefined {
    return this.transactionStack[this.transactionStack.length - 1];
  }

  private dispatch(event: DomainEvent): void {
    for (const subscriber of this.subscribers) {
      try {
        const result = subscriber.handle(event);
        // Handle async subscribers without blocking
        if (result instanceof Promise) {
          result.catch((error) => {
            logger.error(`Event subscriber error for ${event.type}: ${error}`);
          });
        }
      } catch (error) {
        logger.error(`Event subscriber sync error for ${event.type}: ${error}`);
      }
    }
  }
}

/**
 * Event type constants for type-safe event publishing.
 */
export const EventTypes = {
  // Draft events
  DRAFT_PICK: 'draft:pick',
  DRAFT_STARTED: 'draft:started',
  DRAFT_COMPLETED: 'draft:completed',
  DRAFT_PAUSED: 'draft:paused',
  DRAFT_RESUMED: 'draft:resumed',
  DRAFT_CREATED: 'draft:created',
  DRAFT_SETTINGS_UPDATED: 'draft:settings_updated',
  DRAFT_ORDER_UPDATED: 'draft:order_updated',
  DRAFT_NEXT_PICK: 'draft:next_pick',
  DRAFT_PICK_UNDONE: 'draft:pick_undone',
  DRAFT_AUTODRAFT_TOGGLED: 'draft:autodraft_toggled',
  DRAFT_QUEUE_UPDATED: 'draft:queue_updated',

  // Auction events
  AUCTION_BID: 'auction:bid',
  AUCTION_LOT_SOLD: 'auction:lot_sold',
  AUCTION_LOT_STARTED: 'auction:lot_started',
  AUCTION_LOT_PASSED: 'auction:lot_passed',
  AUCTION_OUTBID: 'auction:outbid',
  AUCTION_NOMINATOR_CHANGED: 'auction:nominator_changed',
  AUCTION_ERROR: 'auction:error',

  // Derby events
  DERBY_STATE: 'derby:state',
  DERBY_SLOT_PICKED: 'derby:slot_picked',
  DERBY_TURN_CHANGED: 'derby:turn_changed',
  DERBY_PHASE_TRANSITION: 'derby:phase_transition',

  // Trade events
  TRADE_PROPOSED: 'trade:proposed',
  TRADE_ACCEPTED: 'trade:accepted',
  TRADE_REJECTED: 'trade:rejected',
  TRADE_CANCELLED: 'trade:cancelled',
  TRADE_VETOED: 'trade:vetoed',
  TRADE_COUNTERED: 'trade:countered',
  TRADE_COMPLETED: 'trade:completed',
  TRADE_EXPIRED: 'trade:expired',
  TRADE_INVALIDATED: 'trade:invalidated',
  TRADE_VOTE_CAST: 'trade:vote_cast',
  PICK_TRADED: 'trade:pick_traded',

  // Waiver events
  WAIVER_CLAIMED: 'waiver:claimed',
  WAIVER_PROCESSED: 'waiver:processed',
  WAIVER_CLAIM_SUCCESSFUL: 'waiver:claim_successful',
  WAIVER_CLAIM_FAILED: 'waiver:claim_failed',
  WAIVER_CLAIM_CANCELLED: 'waiver:claim_cancelled',
  WAIVER_CLAIM_UPDATED: 'waiver:claim_updated',
  WAIVER_PRIORITY_UPDATED: 'waiver:priority_updated',
  WAIVER_BUDGET_UPDATED: 'waiver:budget_updated',

  // Scoring events
  SCORES_UPDATED: 'scores:updated',
  MATCHUP_FINALIZED: 'matchup:finalized',

  // Chat events
  CHAT_MESSAGE: 'chat:message',
  DM_MESSAGE: 'dm:message',
  DM_READ: 'dm:read',

  // Roster events
  ROSTER_UPDATED: 'roster:updated',
  PLAYER_ADDED: 'roster:player_added',
  PLAYER_DROPPED: 'roster:player_dropped',

  // League events
  LEAGUE_UPDATED: 'league:updated',
  MEMBER_JOINED: 'league:member_joined',
  MEMBER_LEFT: 'league:member_left',
  MEMBER_KICKED: 'league:member_kicked',

  // Invitation events
  INVITATION_RECEIVED: 'invitation:received',
  INVITATION_DECLINED: 'invitation:declined',
  INVITATION_CANCELLED: 'invitation:cancelled',
} as const;

export type EventType = (typeof EventTypes)[keyof typeof EventTypes];
