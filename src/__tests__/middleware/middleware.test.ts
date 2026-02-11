import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authMiddleware, AuthRequest } from '../../middleware/auth.middleware';
import { errorHandler } from '../../middleware/error.middleware';
import { validateRequest } from '../../middleware/validation.middleware';
import {
  AppException,
  ValidationException,
  NotFoundException,
  ForbiddenException,
  ConflictException,
  DatabaseException,
} from '../../utils/exceptions';
import { verifyToken } from '../../utils/jwt';

// verifyToken is globally mocked in setup.ts
const mockVerifyToken = verifyToken as jest.MockedFunction<typeof verifyToken>;

// Mock metrics, logger, and env used by error middleware
jest.mock('../../services/metrics.service', () => ({
  metrics: {
    increment: jest.fn(),
  },
}));

jest.mock('../../config/logger.config', () => ({
  logger: {
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

// Default to non-production for most tests; individual tests override as needed
let mockNodeEnv = 'development';
jest.mock('../../config/env.config', () => ({
  get env() {
    return { NODE_ENV: mockNodeEnv };
  },
}));

// ---------- Helpers ----------

function createMockRequest(overrides: Partial<Request> = {}): Request {
  return {
    headers: {},
    path: '/test',
    method: 'GET',
    body: {},
    query: {},
    params: {},
    ...overrides,
  } as unknown as Request;
}

function createMockResponse(): Response {
  const res: Partial<Response> = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res as Response;
}

function createMockNext(): NextFunction {
  return jest.fn();
}

// ===========================
// Auth Middleware Tests
// ===========================
describe('authMiddleware', () => {
  let res: Response;
  let next: NextFunction;

  beforeEach(() => {
    res = createMockResponse();
    next = createMockNext();
    mockVerifyToken.mockReset();
  });

  it('should return 401 when no Authorization header is present', () => {
    const req = createMockRequest({ headers: {} }) as AuthRequest;

    authMiddleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      error: {
        code: 'UNAUTHORIZED',
        message: 'Missing or invalid Authorization header',
      },
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('should return 401 when token format is wrong (not Bearer)', () => {
    const req = createMockRequest({
      headers: { authorization: 'Basic some_token' },
    }) as AuthRequest;

    authMiddleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      error: {
        code: 'UNAUTHORIZED',
        message: 'Missing or invalid Authorization header',
      },
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('should return 401 when token verification fails', () => {
    mockVerifyToken.mockImplementation(() => {
      throw new Error('Invalid token');
    });

    const req = createMockRequest({
      headers: { authorization: 'Bearer bad_token' },
    }) as AuthRequest;

    authMiddleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      error: {
        code: 'INVALID_TOKEN',
        message: 'Invalid or expired token',
      },
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('should return 401 when a refresh token is used as an access token', () => {
    mockVerifyToken.mockReturnValue({
      sub: 'user-123',
      userId: 'user-123',
      username: 'testuser',
      type: 'refresh',
    });

    const req = createMockRequest({
      headers: { authorization: 'Bearer valid_refresh_token' },
    }) as AuthRequest;

    authMiddleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      error: {
        code: 'INVALID_TOKEN',
        message: 'Invalid or expired token',
      },
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('should set req.user and call next() on valid access token', () => {
    mockVerifyToken.mockReturnValue({
      sub: 'user-456',
      userId: 'user-456',
      username: 'janesmith',
      type: 'access',
    });

    const req = createMockRequest({
      headers: { authorization: 'Bearer valid_access_token' },
    }) as AuthRequest;

    authMiddleware(req, res, next);

    expect(req.user).toEqual({
      userId: 'user-456',
      username: 'janesmith',
    });
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('should handle malformed header gracefully (empty Bearer value)', () => {
    // "Bearer " with no token - verifyToken will receive an empty string
    mockVerifyToken.mockImplementation(() => {
      throw new Error('jwt must be provided');
    });

    const req = createMockRequest({
      headers: { authorization: 'Bearer ' },
    }) as AuthRequest;

    authMiddleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      error: {
        code: 'INVALID_TOKEN',
        message: 'Invalid or expired token',
      },
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('should handle header that is just "Bearer" with no space or token', () => {
    // "Bearer" without trailing space does not start with "Bearer "
    const req = createMockRequest({
      headers: { authorization: 'Bearer' },
    }) as AuthRequest;

    authMiddleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      error: {
        code: 'UNAUTHORIZED',
        message: 'Missing or invalid Authorization header',
      },
    });
    expect(next).not.toHaveBeenCalled();
  });
});

// ===========================
// Error Middleware Tests
// ===========================
describe('errorHandler', () => {
  let req: Request;
  let res: Response;
  let next: NextFunction;
  let mockMetrics: { increment: jest.Mock };
  let mockLogger: { warn: jest.Mock; error: jest.Mock };

  beforeEach(() => {
    req = createMockRequest({ path: '/api/test', method: 'POST' });
    res = createMockResponse();
    next = createMockNext();
    mockNodeEnv = 'development';

    // Re-import mocks to get references
    mockMetrics = jest.requireMock('../../services/metrics.service').metrics;
    mockLogger = jest.requireMock('../../config/logger.config').logger;
    mockMetrics.increment.mockClear();
    mockLogger.warn.mockClear();
    mockLogger.error.mockClear();
  });

  describe('AppException subtypes', () => {
    it('should return 400 for ValidationException', () => {
      const err = new ValidationException('Name is required');

      errorHandler(err, req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Name is required',
        },
      });
      expect(mockMetrics.increment).toHaveBeenCalledWith('errors_total');
      expect(mockLogger.warn).toHaveBeenCalled();
    });

    it('should return 404 for NotFoundException', () => {
      const err = new NotFoundException('League not found');

      errorHandler(err, req, res, next);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({
        error: {
          code: 'NOT_FOUND',
          message: 'League not found',
        },
      });
    });

    it('should return 403 for ForbiddenException', () => {
      const err = new ForbiddenException('Access denied');

      errorHandler(err, req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({
        error: {
          code: 'FORBIDDEN',
          message: 'Access denied',
        },
      });
    });

    it('should return 409 for ConflictException', () => {
      const err = new ConflictException('Username already taken');

      errorHandler(err, req, res, next);

      expect(res.status).toHaveBeenCalledWith(409);
      expect(res.json).toHaveBeenCalledWith({
        error: {
          code: 'CONFLICT',
          message: 'Username already taken',
        },
      });
    });

    it('should return 500 for DatabaseException', () => {
      const err = new DatabaseException('Database operation failed: insert');

      errorHandler(err, req, res, next);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        error: {
          code: 'DATABASE_ERROR',
          message: 'Database operation failed: insert',
        },
      });
    });
  });

  describe('unknown errors', () => {
    it('should return 500 for unknown errors with generic message', () => {
      const err = new Error('Something unexpected happened');

      errorHandler(err, req, res, next);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        error: {
          code: 'INTERNAL_ERROR',
          message: 'An error occurred while processing your request',
        },
      });
      expect(mockMetrics.increment).toHaveBeenCalledWith('errors_total');
    });

    it('should not expose internal error message to client', () => {
      const err = new Error('TypeError: Cannot read property x of undefined');

      errorHandler(err, req, res, next);

      const jsonCall = (res.json as jest.Mock).mock.calls[0][0];
      expect(jsonCall.error.message).not.toContain('TypeError');
      expect(jsonCall.error.message).toBe('An error occurred while processing your request');
    });
  });

  describe('production masking', () => {
    it('should not include stack trace in log payload in production', () => {
      mockNodeEnv = 'production';
      const err = new Error('Secret internal info');

      errorHandler(err, req, res, next);

      // In production, logger.error is called without stack
      const logPayload = mockLogger.error.mock.calls[0][1];
      expect(logPayload.stack).toBeUndefined();
      expect(logPayload.errorType).toBe('Error');
    });

    it('should include stack trace in log payload in development', () => {
      mockNodeEnv = 'development';
      const err = new Error('Dev debug info');

      errorHandler(err, req, res, next);

      const logPayload = mockLogger.error.mock.calls[0][1];
      expect(logPayload.stack).toBeDefined();
      expect(logPayload.errorType).toBeUndefined();
    });
  });

  describe('database errors', () => {
    it('should detect and return DATABASE_ERROR code for errors with db-related messages', () => {
      const err = new Error('relation "users" does not exist');

      errorHandler(err, req, res, next);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        error: {
          code: 'DATABASE_ERROR',
          message: 'An error occurred while processing your request',
        },
      });
      expect(mockMetrics.increment).toHaveBeenCalledWith('database_errors_total');
    });

    it('should detect duplicate key violation as database error', () => {
      const err = new Error('duplicate key value violates unique constraint "users_pkey"');

      errorHandler(err, req, res, next);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({ code: 'DATABASE_ERROR' }),
        })
      );
    });

    it('should detect constraint violation as database error', () => {
      const err = new Error('null value in column "name" violates not-null constraint');

      errorHandler(err, req, res, next);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({ code: 'DATABASE_ERROR' }),
        })
      );
    });

    it('should detect error by name pattern (DatabaseError)', () => {
      const err = new Error('some opaque message');
      err.name = 'DatabaseError';

      errorHandler(err, req, res, next);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({ code: 'DATABASE_ERROR' }),
        })
      );
    });

    it('should return INTERNAL_ERROR for non-database unknown errors', () => {
      const err = new Error('Cannot read property of undefined');

      errorHandler(err, req, res, next);

      expect(res.json).toHaveBeenCalledWith({
        error: {
          code: 'INTERNAL_ERROR',
          message: 'An error occurred while processing your request',
        },
      });
    });

    it('should never expose database schema details to the client', () => {
      const err = new Error('column "password_hash" of relation "users" does not exist');

      errorHandler(err, req, res, next);

      const jsonCall = (res.json as jest.Mock).mock.calls[0][0];
      expect(jsonCall.error.message).not.toContain('password_hash');
      expect(jsonCall.error.message).not.toContain('users');
      expect(jsonCall.error.message).toBe('An error occurred while processing your request');
    });
  });
});

// ===========================
// Validation Middleware Tests
// ===========================
describe('validateRequest', () => {
  let res: Response;
  let next: NextFunction;

  beforeEach(() => {
    res = createMockResponse();
    next = createMockNext();
  });

  const testSchema = z.object({
    name: z.string().min(1, 'Name is required'),
    age: z.number().min(0, 'Age must be non-negative'),
  });

  describe('body validation (default source)', () => {
    it('should call next() and set validated data on valid body', async () => {
      const req = createMockRequest({
        body: { name: 'Alice', age: 30 },
      });

      const middleware = validateRequest(testSchema);
      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.body).toEqual({ name: 'Alice', age: 30 });
      expect(res.status).not.toHaveBeenCalled();
    });

    it('should return 400 with error message on validation failure', async () => {
      const req = createMockRequest({
        body: { name: '', age: 30 },
      });

      const middleware = validateRequest(testSchema);
      await middleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Name is required',
        },
      });
      expect(next).not.toHaveBeenCalled();
    });

    it('should return the first error when multiple fields fail', async () => {
      const req = createMockRequest({
        body: { name: '', age: -5 },
      });

      const middleware = validateRequest(testSchema);
      await middleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      // Should return only one error message (the first one)
      const jsonCall = (res.json as jest.Mock).mock.calls[0][0];
      expect(typeof jsonCall.error.message).toBe('string');
      expect(next).not.toHaveBeenCalled();
    });

    it('should return 400 when body is missing required fields', async () => {
      const req = createMockRequest({
        body: {},
      });

      const middleware = validateRequest(testSchema);
      await middleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({ code: 'VALIDATION_ERROR' }),
        })
      );
      expect(next).not.toHaveBeenCalled();
    });

    it('should strip extra fields not in the schema (strict by default in Zod)', async () => {
      const looseSchema = z.object({
        name: z.string(),
      });

      const req = createMockRequest({
        body: { name: 'Alice', extraField: 'ignored' },
      });

      const middleware = validateRequest(looseSchema);
      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      // Zod strips unrecognized keys by default
      expect(req.body).toEqual({ name: 'Alice' });
    });
  });

  describe('query source', () => {
    it('should validate and replace query params on success', async () => {
      const querySchema = z.object({
        page: z.string().regex(/^\d+$/, 'Page must be numeric'),
      });

      const req = createMockRequest({
        query: { page: '5' } as any,
      });

      const middleware = validateRequest(querySchema, 'query');
      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.query).toEqual({ page: '5' });
    });

    it('should return 400 on invalid query params', async () => {
      const querySchema = z.object({
        page: z.string().regex(/^\d+$/, 'Page must be numeric'),
      });

      const req = createMockRequest({
        query: { page: 'abc' } as any,
      });

      const middleware = validateRequest(querySchema, 'query');
      await middleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Page must be numeric',
        },
      });
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('params source', () => {
    it('should validate route params and pass validated data through', async () => {
      const paramsSchema = z.object({
        id: z.string().uuid('Invalid ID format'),
      });

      const req = createMockRequest({
        params: { id: '550e8400-e29b-41d4-a716-446655440000' } as any,
      });

      const middleware = validateRequest(paramsSchema, 'params');
      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.params).toEqual({ id: '550e8400-e29b-41d4-a716-446655440000' });
    });

    it('should return 400 on invalid route params', async () => {
      const paramsSchema = z.object({
        id: z.string().uuid('Invalid ID format'),
      });

      const req = createMockRequest({
        params: { id: 'not-a-uuid' } as any,
      });

      const middleware = validateRequest(paramsSchema, 'params');
      await middleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid ID format',
        },
      });
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('non-Zod errors', () => {
    it('should return 500 when schema.parseAsync throws a non-Zod error', async () => {
      const brokenSchema = {
        parseAsync: jest.fn().mockRejectedValue(new Error('Unexpected internal error')),
      } as unknown as z.ZodSchema;

      const req = createMockRequest({ body: { name: 'Alice' } });

      const middleware = validateRequest(brokenSchema);
      await middleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Internal server error during validation',
        },
      });
      expect(next).not.toHaveBeenCalled();
    });
  });
});
