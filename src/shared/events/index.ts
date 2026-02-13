export {
  DomainEventBus,
  DomainEvent,
  DomainEventSubscriber,
  EventTypes,
  EventType,
} from './domain-event-bus';

export { SocketEventSubscriber } from './socket-event-subscriber';
export { NotificationEventSubscriber } from './notification-event-subscriber';

import { container, KEYS } from '../../container';
import { DomainEventBus } from './domain-event-bus';

/**
 * Safely get the domain event bus, returning null if not registered.
 * This is useful for code that may run in test environments where
 * the event bus is not bootstrapped.
 */
export function tryGetEventBus(): DomainEventBus | null {
  return container.tryResolve<DomainEventBus>(KEYS.DOMAIN_EVENT_BUS);
}
