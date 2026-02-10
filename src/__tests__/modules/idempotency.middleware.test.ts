import { Request, Response, NextFunction } from 'express';
import { Pool } from 'pg';
import { idempotencyMiddleware } from '../../middleware/idempotency.middleware';

// Mock logger
jest.mock('../../config/logger.config', () => ({
  logger: {
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
  },
}));

describe('IdempotencyMiddleware', () => {
  let mockQuery: jest.Mock;
  let mockPool: Pool;
  let middleware: ReturnType<typeof idempotencyMiddleware>;
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let mockNext: jest.MockedFunction<NextFunction>;

  beforeEach(() => {
    mockQuery = jest.fn();
    mockPool = { query: mockQuery } as unknown as Pool;

    middleware = idempotencyMiddleware(mockPool);

    mockReq = {
      method: 'POST',
      originalUrl: '/api/trades/1/accept',
      headers: {},
    };

    mockRes = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
      statusCode: 200,
    };

    mockNext = jest.fn();
  });

  it('should skip if no idempotency key header', async () => {
    await middleware(mockReq as Request, mockRes as Response, mockNext);

    expect(mockNext).toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('should skip for GET requests', async () => {
    mockReq.method = 'GET';
    mockReq.headers = { 'x-idempotency-key': 'test-key-1' };
    (mockReq as any).user = { userId: 'user-1' };

    await middleware(mockReq as Request, mockRes as Response, mockNext);

    expect(mockNext).toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('should skip if user is not authenticated', async () => {
    mockReq.headers = { 'x-idempotency-key': 'test-key-1' };

    await middleware(mockReq as Request, mockRes as Response, mockNext);

    expect(mockNext).toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  describe('claim-before-execute pattern', () => {
    beforeEach(() => {
      mockReq.headers = { 'x-idempotency-key': 'test-key-1' };
      (mockReq as any).user = { userId: 'user-1' };
    });

    it('should claim key and proceed when key is new', async () => {
      // INSERT returns a row (claim successful)
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 } as any);

      await middleware(mockReq as Request, mockRes as Response, mockNext);

      // Should have called INSERT to claim the key
      expect(mockQuery).toHaveBeenCalledTimes(1);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO idempotency_keys'),
        expect.arrayContaining(['test-key-1'])
      );

      // Should proceed to handler
      expect(mockNext).toHaveBeenCalled();

      // res.json should be wrapped to capture response
      expect(mockRes.json).not.toBe(jest.fn());
    });

    it('should return cached response when key has completed response', async () => {
      const cachedBody = { success: true, data: { tradeId: 1 } };

      // INSERT returns 0 rows (key exists)
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      // SELECT returns completed response
      mockQuery.mockResolvedValueOnce({
        rows: [{ response_status: 200, response_body: cachedBody }],
        rowCount: 1,
      } as any);

      await middleware(mockReq as Request, mockRes as Response, mockNext);

      // Should NOT proceed to handler
      expect(mockNext).not.toHaveBeenCalled();

      // Should return cached response
      expect(mockRes.status).toHaveBeenCalledWith(200);
      expect(mockRes.json).toHaveBeenCalledWith(cachedBody);
    });

    it('should return 409 when another request is in-flight', async () => {
      // INSERT returns 0 rows (key exists)
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      // SELECT returns in-flight record (status=0, body=null)
      mockQuery.mockResolvedValueOnce({
        rows: [{ response_status: 0, response_body: null }],
        rowCount: 1,
      } as any);

      await middleware(mockReq as Request, mockRes as Response, mockNext);

      // Should NOT proceed to handler
      expect(mockNext).not.toHaveBeenCalled();

      // Should return 409
      expect(mockRes.status).toHaveBeenCalledWith(409);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.stringContaining('already being processed') })
      );
    });

    it('should re-claim expired key', async () => {
      // INSERT returns 0 rows (key exists)
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      // SELECT returns 0 rows (key expired)
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      // DELETE expired key
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);

      // Re-INSERT returns a row (claim successful)
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 2 }], rowCount: 1 } as any);

      await middleware(mockReq as Request, mockRes as Response, mockNext);

      // Should proceed to handler
      expect(mockNext).toHaveBeenCalled();

      // Should have called DELETE for expired key
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('DELETE FROM idempotency_keys'),
        expect.arrayContaining(['test-key-1'])
      );
    });

    it('should store response via wrapped res.json', async () => {
      // INSERT returns a row (claim successful)
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 } as any);
      // UPDATE for storing response (called when res.json is invoked)
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);

      await middleware(mockReq as Request, mockRes as Response, mockNext);

      // Simulate the handler calling res.json
      const responseBody = { success: true, tradeId: 1 };
      mockRes.json!(responseBody);

      // Should have called UPDATE to store the response
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE idempotency_keys'),
        expect.arrayContaining([JSON.stringify(responseBody), 'test-key-1'])
      );
    });

    it('should pass through on DB error during claim', async () => {
      // INSERT throws an error
      mockQuery.mockRejectedValueOnce(new Error('DB connection error'));

      await middleware(mockReq as Request, mockRes as Response, mockNext);

      // Should still proceed to handler (graceful degradation)
      expect(mockNext).toHaveBeenCalled();
    });
  });
});
