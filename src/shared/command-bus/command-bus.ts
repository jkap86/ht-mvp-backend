/**
 * Command Bus - Central Mutation Gateway
 *
 * This module provides a thin command dispatcher layer for all domain mutations.
 * It routes commands to appropriate handlers, provides logging/timing, and
 * enables cross-cutting concerns without introducing CQRS or event sourcing complexity.
 *
 * Key design principles:
 * - Thin layer: handlers wrap existing services/use-cases
 * - Type-safe: commands are strongly typed with payloads
 * - Observable: all commands are logged with timing
 * - Extensible: new handlers can be registered dynamically
 */

import { logger } from '../../config/logger.config';
import { Command, CommandType } from '../../domain/commands';

/**
 * Result of executing a command
 */
export interface CommandResult<T = unknown> {
  /** Whether the command executed successfully */
  success: boolean;
  /** Result data if successful */
  data?: T;
  /** Error if failed */
  error?: Error;
  /** Execution duration in milliseconds */
  durationMs: number;
}

/**
 * Interface for command handlers.
 * Each handler is responsible for a specific command type.
 */
export interface CommandHandler<TPayload = unknown, TResult = unknown> {
  /** The command type this handler processes */
  readonly commandType: CommandType;
  /** Handle the command and return a result */
  handle(command: Command<TPayload>): Promise<TResult>;
}

/**
 * CommandBus dispatches commands to registered handlers.
 *
 * Usage:
 * ```typescript
 * const bus = new CommandBus();
 * bus.register(new DraftMakePickHandler());
 *
 * const result = await bus.dispatch({
 *   type: CommandTypes.DRAFT_MAKE_PICK,
 *   payload: { draftId: 1, playerId: 100 },
 *   actor: { userId: 'user-123' }
 * });
 * ```
 */
export class CommandBus {
  private handlers = new Map<CommandType, CommandHandler>();
  private middlewares: CommandMiddleware[] = [];

  /**
   * Register a command handler.
   * @throws Error if handler already registered for this command type
   */
  register(handler: CommandHandler): void {
    if (this.handlers.has(handler.commandType)) {
      throw new Error(`Handler already registered for command: ${handler.commandType}`);
    }
    this.handlers.set(handler.commandType, handler);
    logger.debug(`Registered command handler for: ${handler.commandType}`);
  }

  /**
   * Register multiple handlers at once.
   */
  registerAll(handlers: CommandHandler[]): void {
    for (const handler of handlers) {
      this.register(handler);
    }
  }

  /**
   * Add middleware that runs before command execution.
   */
  use(middleware: CommandMiddleware): void {
    this.middlewares.push(middleware);
  }

  /**
   * Dispatch a command to its handler.
   * @returns CommandResult with success status, data/error, and timing
   */
  async dispatch<TPayload, TResult>(
    command: Command<TPayload>
  ): Promise<CommandResult<TResult>> {
    const startTime = Date.now();

    // Get handler
    const handler = this.handlers.get(command.type as CommandType);
    if (!handler) {
      const error = new Error(`No handler registered for command: ${command.type}`);
      logger.error('Command dispatch failed: no handler', {
        type: command.type,
        actor: command.actor.userId,
      });
      return {
        success: false,
        error,
        durationMs: Date.now() - startTime,
      };
    }

    // Log command start
    logger.debug('Dispatching command', {
      type: command.type,
      actor: command.actor.userId,
      correlationId: command.metadata?.correlationId,
      idempotencyKey: command.metadata?.idempotencyKey,
    });

    try {
      // Run middlewares
      for (const middleware of this.middlewares) {
        await middleware.before(command);
      }

      // Execute handler
      const result = await handler.handle(command);
      const durationMs = Date.now() - startTime;

      // Log success
      logger.info('Command executed successfully', {
        type: command.type,
        actor: command.actor.userId,
        durationMs,
      });

      // Run post-middlewares
      for (const middleware of this.middlewares) {
        if (middleware.after) {
          await middleware.after(command, result);
        }
      }

      return {
        success: true,
        data: result as TResult,
        durationMs,
      };
    } catch (error) {
      const durationMs = Date.now() - startTime;

      // Log failure
      logger.error('Command execution failed', {
        type: command.type,
        actor: command.actor.userId,
        error: error instanceof Error ? error.message : String(error),
        durationMs,
      });

      // Run error middlewares
      for (const middleware of this.middlewares) {
        if (middleware.onError) {
          await middleware.onError(command, error as Error);
        }
      }

      return {
        success: false,
        error: error instanceof Error ? error : new Error(String(error)),
        durationMs,
      };
    }
  }

  /**
   * Get all registered command types.
   */
  getRegisteredCommands(): CommandType[] {
    return Array.from(this.handlers.keys());
  }

  /**
   * Check if a handler is registered for a command type.
   */
  hasHandler(commandType: CommandType): boolean {
    return this.handlers.has(commandType);
  }

  /**
   * Clear all handlers (useful for testing).
   */
  clear(): void {
    this.handlers.clear();
    this.middlewares = [];
  }
}

/**
 * Middleware interface for cross-cutting concerns.
 * Middlewares can run before/after commands or on error.
 */
export interface CommandMiddleware {
  /** Called before command execution */
  before(command: Command): void | Promise<void>;
  /** Called after successful command execution (optional) */
  after?(command: Command, result: unknown): void | Promise<void>;
  /** Called when command execution fails (optional) */
  onError?(command: Command, error: Error): void | Promise<void>;
}

/**
 * Logging middleware - logs all commands with timing.
 * This is registered by default but can be customized.
 */
export class LoggingMiddleware implements CommandMiddleware {
  async before(command: Command): Promise<void> {
    // Logging is handled in dispatch() for timing accuracy
  }
}

/**
 * Idempotency middleware - prevents duplicate command execution.
 * Uses a simple in-memory cache (for production, use Redis).
 */
export class IdempotencyMiddleware implements CommandMiddleware {
  private processedKeys = new Map<string, { timestamp: number; result: unknown }>();
  private readonly ttlMs: number;
  private readonly maxResultBytes: number;
  private readonly cleanupInterval: ReturnType<typeof setInterval>;

  constructor(ttlMs: number = 5 * 60 * 1000, maxResultBytes: number = 102_400) {
    // Default 5 minutes TTL, 100KB max result size
    this.ttlMs = ttlMs;
    this.maxResultBytes = maxResultBytes;

    // Periodic cleanup every 5 minutes to remove expired entries
    this.cleanupInterval = setInterval(() => this.cleanup(), 5 * 60 * 1000);
    // unref() so the interval doesn't prevent Node.js from shutting down
    this.cleanupInterval.unref();
  }

  async before(command: Command): Promise<void> {
    const key = command.metadata?.idempotencyKey;
    if (!key) return;

    const cached = this.processedKeys.get(key);
    if (cached && Date.now() - cached.timestamp < this.ttlMs) {
      throw new IdempotencyError(key, cached.result);
    }
  }

  async after(command: Command, result: unknown): Promise<void> {
    const key = command.metadata?.idempotencyKey;
    if (!key) return;

    // Skip caching if the serialized result exceeds the size limit
    try {
      const serialized = JSON.stringify(result);
      if (Buffer.byteLength(serialized, 'utf8') > this.maxResultBytes) {
        logger.warn('Idempotency result too large, skipping cache', {
          key,
          limit: this.maxResultBytes,
        });
        return;
      }
    } catch {
      // If serialization fails (circular refs, etc.), skip caching
      logger.warn('Idempotency result not serializable, skipping cache', { key });
      return;
    }

    this.processedKeys.set(key, { timestamp: Date.now(), result });

    // Cleanup old entries if map grows too large
    if (this.processedKeys.size > 1000) {
      this.cleanup();
    }
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, value] of this.processedKeys) {
      if (now - value.timestamp > this.ttlMs) {
        this.processedKeys.delete(key);
      }
    }
  }

  /** Stop the periodic cleanup interval. Call when shutting down. */
  dispose(): void {
    clearInterval(this.cleanupInterval);
  }
}

/**
 * Error thrown when an idempotency key has already been processed.
 */
export class IdempotencyError extends Error {
  constructor(
    public readonly key: string,
    public readonly cachedResult: unknown
  ) {
    super(`Command with idempotency key '${key}' has already been processed`);
    this.name = 'IdempotencyError';
  }
}

/**
 * Singleton instance of the command bus.
 * Prefer using container.resolve(KEYS.COMMAND_BUS) in production code.
 */
let commandBusInstance: CommandBus | null = null;

/**
 * Get or create the singleton command bus instance.
 * Used for bootstrapping; prefer DI container in application code.
 */
export function getCommandBus(): CommandBus {
  if (!commandBusInstance) {
    commandBusInstance = new CommandBus();
  }
  return commandBusInstance;
}

/**
 * Try to get command bus, returning null if not initialized.
 * Useful for optional command bus usage in existing code paths.
 */
export function tryGetCommandBus(): CommandBus | null {
  return commandBusInstance;
}

/**
 * Reset the command bus singleton (for testing).
 */
export function resetCommandBus(): void {
  if (commandBusInstance) {
    commandBusInstance.clear();
  }
  commandBusInstance = null;
}
