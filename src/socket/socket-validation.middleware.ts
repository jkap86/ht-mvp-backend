import { Socket } from 'socket.io';
import { z, ZodSchema } from 'zod';
import { logger } from '../config/logger.config';
import { SOCKET_EVENTS } from '../constants/socket-events';

/**
 * Validation error response sent to client
 */
export interface SocketValidationError {
  code: 'VALIDATION_ERROR';
  message: string;
  event: string;
  details?: z.ZodIssue[];
}

/**
 * Type-safe validated data handler
 */
export type ValidatedHandler<T> = (data: T) => void | Promise<void>;

/**
 * Register a socket event handler with Zod validation.
 * Validates incoming payloads like HTTP controllers and sends structured errors on failure.
 *
 * @param socket - The Socket.IO socket instance
 * @param event - The event name to listen for
 * @param schema - Zod schema to validate the payload against
 * @param handler - Handler function that receives validated, typed data
 *
 * @example
 * ```typescript
 * onValidated(socket, 'join:league', joinLeagueSchema, async ({ leagueId }) => {
 *   // Handler receives validated, typed data
 *   await handleLeagueJoin(socket, leagueId);
 * });
 * ```
 */
export function onValidated<T>(
  socket: Socket,
  event: string,
  schema: ZodSchema<T>,
  handler: ValidatedHandler<T>
): void {
  socket.on(event, async (data: unknown) => {
    const result = schema.safeParse(data);

    if (!result.success) {
      const error: SocketValidationError = {
        code: 'VALIDATION_ERROR',
        message: formatValidationError(result.error),
        event,
        details: result.error.issues,
      };

      logger.warn('Socket validation failed', {
        event,
        socketId: socket.id,
        errors: result.error.issues,
      });

      socket.emit(SOCKET_EVENTS.APP.ERROR, error);
      return;
    }

    try {
      await handler(result.data);
    } catch (err) {
      logger.error('Socket handler error', {
        event,
        socketId: socket.id,
        error: err instanceof Error ? err.message : String(err),
      });

      socket.emit(SOCKET_EVENTS.APP.ERROR, {
        code: 'HANDLER_ERROR',
        message: err instanceof Error ? err.message : 'Internal error',
        event,
      });
    }
  });
}

/**
 * Format a Zod validation error into a user-friendly message
 */
function formatValidationError(error: z.ZodError): string {
  const firstIssue = error.issues[0];
  if (!firstIssue) {
    return 'Invalid payload';
  }

  const path = firstIssue.path.join('.');
  const prefix = path ? `${path}: ` : '';

  // Use the message directly - Zod provides good default messages
  // This approach is more compatible across Zod versions
  return `${prefix}${firstIssue.message}`;
}

/**
 * Create a validated event handler factory for a socket.
 * Useful when registering many validated events on the same socket.
 *
 * @example
 * ```typescript
 * const validated = createValidatedSocket(socket);
 * validated('join:league', joinLeagueSchema, handleJoinLeague);
 * validated('join:draft', joinDraftSchema, handleJoinDraft);
 * ```
 */
export function createValidatedSocket(socket: Socket) {
  return function validated<T>(
    event: string,
    schema: ZodSchema<T>,
    handler: ValidatedHandler<T>
  ): void {
    onValidated(socket, event, schema, handler);
  };
}

/**
 * Validate data synchronously without registering a handler.
 * Useful for validating payloads in existing event handlers.
 *
 * @returns The validated data or null if validation failed (error emitted to socket)
 *
 * @example
 * ```typescript
 * socket.on('legacy:event', (data) => {
 *   const validated = validatePayload(socket, 'legacy:event', mySchema, data);
 *   if (!validated) return; // Error already emitted
 *   // Use validated data...
 * });
 * ```
 */
export function validatePayload<T>(
  socket: Socket,
  event: string,
  schema: ZodSchema<T>,
  data: unknown
): T | null {
  const result = schema.safeParse(data);

  if (!result.success) {
    const error: SocketValidationError = {
      code: 'VALIDATION_ERROR',
      message: formatValidationError(result.error),
      event,
      details: result.error.issues,
    };

    logger.warn('Socket validation failed', {
      event,
      socketId: socket.id,
      errors: result.error.issues,
    });

    socket.emit(SOCKET_EVENTS.APP.ERROR, error);
    return null;
  }

  return result.data;
}
