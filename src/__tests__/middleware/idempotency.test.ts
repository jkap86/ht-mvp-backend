import { Request, Response, NextFunction } from 'express';
import { Pool } from 'pg';
import { idempotencyMiddleware } from '../../middleware/idempotency.middleware';
import { AuthRequest } from '../../middleware/auth.middleware';

// Mock logger
jest.mock('../../config/logger.config', () => ({
  logger: {
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}));

// ---------- Helpers ----------

function createMockRequest(overrides: Partial<Request & { user?: { userId: string } }> = {}): AuthRequest {
  return {
    headers: {},
    path: '/test',
    originalUrl: '/api/test',
    method: 'POST',
    body: {},
    query: {},
    params: {},
    user: { userId: 'user-123' },
    ...overrides,
  } as unknown as AuthRequest;
}

function createMockResponse(): Response {
  const res: Partial<Response> & { locals: Record<string, any> } = { locals: {} };
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  res.end = jest.fn().mockReturnValue(res);
  res.on = jest.fn().mockReturnValue(res);
  res.statusCode = 200;
  return res as unknown as Response;
}

function createMockNext(): jest.Mock {
  return jest.fn();
}

function createMockPool(queryImpl?: jest.Mock): Pool {
  const defaultQuery = jest.fn();
  return { query: queryImpl || defaultQuery } as unknown as Pool;
}

// ===========================================================================
// Idempotency Middleware Tests
// ===========================================================================

describe('idempotencyMiddleware', () => {
  let res: Response;
  let next: jest.Mock;

  beforeEach(() => {
    res = createMockResponse();
    next = createMockNext();
  });

  describe('skip conditions', () => {
    it('should skip when no idempotency key is provided', async () => {
      const pool = createMockPool();
      const req = createMockRequest({ headers: {} });

      const middleware = idempotencyMiddleware(pool);
      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect((pool as any).query).not.toHaveBeenCalled();
    });

    it('should skip for GET requests', async () => {
      const pool = createMockPool();
      const req = createMockRequest({
        method: 'GET',
        headers: { 'x-idempotency-key': 'test-key' },
      });

      const middleware = idempotencyMiddleware(pool);
      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    it('should skip for OPTIONS requests', async () => {
      const pool = createMockPool();
      const req = createMockRequest({
        method: 'OPTIONS',
        headers: { 'x-idempotency-key': 'test-key' },
      });

      const middleware = idempotencyMiddleware(pool);
      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    it('should skip when user is not authenticated', async () => {
      const pool = createMockPool();
      const req = createMockRequest({
        headers: { 'x-idempotency-key': 'test-key' },
        user: undefined,
      });

      const middleware = idempotencyMiddleware(pool);
      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
    });
  });

  describe('key validation', () => {
    it('should reject keys longer than 256 characters', async () => {
      const pool = createMockPool();
      const longKey = 'x'.repeat(257);
      const req = createMockRequest({
        headers: { 'x-idempotency-key': longKey },
      });

      const middleware = idempotencyMiddleware(pool);
      await middleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Idempotency key must be 256 characters or fewer',
        },
      });
      expect(next).not.toHaveBeenCalled();
    });

    it('should accept keys at exactly 256 characters', async () => {
      const mockQuery = jest.fn()
        .mockResolvedValueOnce({ rows: [{ id: 1 }] }); // Claim succeeds

      const pool = createMockPool(mockQuery);
      const exactKey = 'x'.repeat(256);
      const req = createMockRequest({
        headers: { 'x-idempotency-key': exactKey },
      });

      const middleware = idempotencyMiddleware(pool);
      await middleware(req, res, next);

      // Should not be rejected for length
      expect(res.status).not.toHaveBeenCalledWith(400);
    });
  });

  describe('first request (claim succeeds)', () => {
    it('should claim key and pass to next handler on first request', async () => {
      const mockQuery = jest.fn()
        .mockResolvedValueOnce({ rows: [{ id: 1 }] }); // INSERT succeeds

      const pool = createMockPool(mockQuery);
      const req = createMockRequest({
        headers: { 'x-idempotency-key': 'unique-key-1' },
      });

      const middleware = idempotencyMiddleware(pool);
      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.locals._idempotencyClaimed).toBe(true);
    });
  });

  describe('duplicate request (in-flight)', () => {
    it('should return 409 when same key is already being processed', async () => {
      const mockQuery = jest.fn()
        // INSERT returns 0 rows (key already exists)
        .mockResolvedValueOnce({ rows: [] })
        // SELECT existing returns in-flight record (response_status = 0)
        .mockResolvedValueOnce({
          rows: [{ response_status: 0, response_body: null }],
        });

      const pool = createMockPool(mockQuery);
      const req = createMockRequest({
        headers: { 'x-idempotency-key': 'duplicate-key' },
      });

      const middleware = idempotencyMiddleware(pool);
      await middleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(409);
      expect(res.json).toHaveBeenCalledWith({
        error: {
          code: 'IDEMPOTENCY_CONFLICT',
          message: 'Request is already being processed',
        },
      });
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('duplicate request (completed)', () => {
    it('should replay cached JSON response for completed request', async () => {
      const cachedBody = { id: 42, name: 'test trade' };
      const mockQuery = jest.fn()
        // INSERT returns 0 rows (key already exists)
        .mockResolvedValueOnce({ rows: [] })
        // SELECT existing returns completed record
        .mockResolvedValueOnce({
          rows: [{ response_status: 201, response_body: cachedBody }],
        });

      const pool = createMockPool(mockQuery);
      const req = createMockRequest({
        headers: { 'x-idempotency-key': 'completed-key' },
      });

      const middleware = idempotencyMiddleware(pool);
      await middleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith(cachedBody);
      expect(next).not.toHaveBeenCalled();
    });

    it('should replay 204 response without body', async () => {
      const mockQuery = jest.fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({
          rows: [{ response_status: 204, response_body: null }],
        });

      const pool = createMockPool(mockQuery);
      const req = createMockRequest({
        headers: { 'x-idempotency-key': 'no-content-key' },
      });

      const middleware = idempotencyMiddleware(pool);
      await middleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(204);
      expect(res.end).toHaveBeenCalled();
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('expired key re-use', () => {
    it('should allow re-use of expired keys after cleanup', async () => {
      const mockQuery = jest.fn()
        // INSERT returns 0 rows (key already exists)
        .mockResolvedValueOnce({ rows: [] })
        // SELECT existing returns 0 rows (expired)
        .mockResolvedValueOnce({ rows: [] })
        // DELETE expired key
        .mockResolvedValueOnce({ rowCount: 1 })
        // Re-INSERT succeeds
        .mockResolvedValueOnce({ rows: [{ id: 2 }] });

      const pool = createMockPool(mockQuery);
      const req = createMockRequest({
        headers: { 'x-idempotency-key': 'expired-key' },
      });

      const middleware = idempotencyMiddleware(pool);
      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.locals._idempotencyClaimed).toBe(true);
    });

    it('should return 409 when reclaim races with another request', async () => {
      const mockQuery = jest.fn()
        // INSERT returns 0 rows (key exists)
        .mockResolvedValueOnce({ rows: [] })
        // SELECT returns 0 rows (expired)
        .mockResolvedValueOnce({ rows: [] })
        // DELETE expired key
        .mockResolvedValueOnce({ rowCount: 1 })
        // Re-INSERT fails (another request claimed it first)
        .mockResolvedValueOnce({ rows: [] });

      const pool = createMockPool(mockQuery);
      const req = createMockRequest({
        headers: { 'x-idempotency-key': 'race-expired-key' },
      });

      const middleware = idempotencyMiddleware(pool);
      await middleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(409);
      expect(res.json).toHaveBeenCalledWith({
        error: {
          code: 'IDEMPOTENCY_CONFLICT',
          message: 'Request is already being processed',
        },
      });
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('DB error fallthrough', () => {
    it('should pass through without idempotency when DB claim fails', async () => {
      const mockQuery = jest.fn()
        .mockRejectedValueOnce(new Error('Connection refused'));

      const pool = createMockPool(mockQuery);
      const req = createMockRequest({
        headers: { 'x-idempotency-key': 'db-error-key' },
      });

      const middleware = idempotencyMiddleware(pool);
      await middleware(req, res, next);

      // Should gracefully fall through to next
      expect(next).toHaveBeenCalled();
    });
  });
});
