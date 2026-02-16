import { Request, Response, NextFunction } from 'express';
import { Pool } from 'pg';
import { idempotencyMiddleware } from '../../middleware/idempotency.middleware';
import { EventEmitter } from 'events';

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
  let mockRes: Partial<Response> & EventEmitter;
  let mockNext: jest.MockedFunction<NextFunction>;

  function createMockRes(): Partial<Response> & EventEmitter {
    const emitter = new EventEmitter();
    const res = Object.assign(emitter, {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
      end: jest.fn().mockReturnThis(),
      send: jest.fn().mockReturnThis(),
      statusCode: 200,
      headersSent: false,
      writableFinished: false,
      locals: {} as Record<string, any>,
    });
    return res as any;
  }

  beforeEach(() => {
    mockQuery = jest.fn();
    mockPool = { query: mockQuery } as unknown as Pool;

    middleware = idempotencyMiddleware(mockPool);

    mockReq = {
      method: 'POST',
      originalUrl: '/api/trades/1/accept',
      headers: {},
    };

    mockRes = createMockRes();
    mockNext = jest.fn();
  });

  it('should skip if no idempotency key header', async () => {
    await middleware(mockReq as Request, mockRes as unknown as Response, mockNext);

    expect(mockNext).toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('should skip for GET requests', async () => {
    mockReq.method = 'GET';
    mockReq.headers = { 'x-idempotency-key': 'test-key-1' };
    (mockReq as any).user = { userId: 'user-1' };

    await middleware(mockReq as Request, mockRes as unknown as Response, mockNext);

    expect(mockNext).toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('should skip if user is not authenticated', async () => {
    mockReq.headers = { 'x-idempotency-key': 'test-key-1' };

    await middleware(mockReq as Request, mockRes as unknown as Response, mockNext);

    expect(mockNext).toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('should reject oversized keys', async () => {
    mockReq.headers = { 'x-idempotency-key': 'x'.repeat(257) };
    (mockReq as any).user = { userId: 'user-1' };

    await middleware(mockReq as Request, mockRes as unknown as Response, mockNext);

    expect(mockNext).not.toHaveBeenCalled();
    expect(mockRes.status).toHaveBeenCalledWith(400);
  });

  describe('claim-before-execute pattern', () => {
    beforeEach(() => {
      mockReq.headers = { 'x-idempotency-key': 'test-key-1' };
      (mockReq as any).user = { userId: 'user-1' };
    });

    it('should claim key and proceed when key is new', async () => {
      // INSERT returns a row (claim successful)
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 } as any);

      await middleware(mockReq as Request, mockRes as unknown as Response, mockNext);

      // Should have called INSERT to claim the key
      expect(mockQuery).toHaveBeenCalledTimes(1);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO idempotency_keys'),
        expect.arrayContaining(['test-key-1'])
      );

      // Should proceed to handler
      expect(mockNext).toHaveBeenCalled();

      // Should set _idempotencyClaimed flag
      expect(mockRes.locals!._idempotencyClaimed).toBe(true);
    });

    it('should return cached response when key has completed response', async () => {
      const cachedBody = { success: true, data: { tradeId: 1 } };

      // INSERT returns 0 rows (key exists)
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      // SELECT returns completed response (body as object from JSONB)
      mockQuery.mockResolvedValueOnce({
        rows: [{ response_status: 200, response_body: cachedBody }],
        rowCount: 1,
      } as any);

      await middleware(mockReq as Request, mockRes as unknown as Response, mockNext);

      // Should NOT proceed to handler
      expect(mockNext).not.toHaveBeenCalled();

      // Should return cached response
      expect(mockRes.status).toHaveBeenCalledWith(200);
      expect(mockRes.json).toHaveBeenCalledWith(cachedBody);
    });

    it('should replay 204 response correctly', async () => {
      // INSERT returns 0 rows (key exists)
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      // SELECT returns completed 204 response (null body)
      mockQuery.mockResolvedValueOnce({
        rows: [{ response_status: 204, response_body: null }],
        rowCount: 1,
      } as any);

      await middleware(mockReq as Request, mockRes as unknown as Response, mockNext);

      // Should NOT proceed to handler
      expect(mockNext).not.toHaveBeenCalled();

      // Should return 204 with end()
      expect(mockRes.status).toHaveBeenCalledWith(204);
      expect(mockRes.end).toHaveBeenCalled();
      expect(mockRes.json).not.toHaveBeenCalled();
    });

    it('should return 409 when another request is in-flight', async () => {
      // INSERT returns 0 rows (key exists)
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      // SELECT returns in-flight record (status=0, body=null, recent)
      mockQuery.mockResolvedValueOnce({
        rows: [{ response_status: 0, response_body: null, created_at: new Date().toISOString() }],
        rowCount: 1,
      } as any);

      await middleware(mockReq as Request, mockRes as unknown as Response, mockNext);

      // Should NOT proceed to handler
      expect(mockNext).not.toHaveBeenCalled();

      // Should return 409
      expect(mockRes.status).toHaveBeenCalledWith(409);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.objectContaining({ message: expect.stringContaining('already being processed') }) })
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

      await middleware(mockReq as Request, mockRes as unknown as Response, mockNext);

      // Should proceed to handler
      expect(mockNext).toHaveBeenCalled();

      // Should have called DELETE for expired key
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('DELETE FROM idempotency_keys'),
        expect.arrayContaining(['test-key-1'])
      );
    });

    it('should store response body as object (not double-stringified)', async () => {
      // INSERT returns a row (claim successful)
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 } as any);
      // UPDATE for storing response
      mockQuery.mockResolvedValue({ rows: [], rowCount: 1 } as any);

      await middleware(mockReq as Request, mockRes as unknown as Response, mockNext);

      // Simulate the handler calling res.json
      const responseBody = { success: true, tradeId: 1 };
      mockRes.json!(responseBody);

      // Should pass body directly (not JSON.stringify(body))
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE idempotency_keys'),
        expect.arrayContaining([responseBody, 'test-key-1'])
      );
      // Verify body is the object, not a string
      const updateCall = mockQuery.mock.calls.find(
        (call: any[]) => typeof call[0] === 'string' && call[0].includes('UPDATE idempotency_keys')
      );
      expect(updateCall).toBeDefined();
      // The body parameter (index 1 in the array) should be the object, not a string
      expect(typeof updateCall![1][1]).toBe('object');
    });

    it('should capture 204 response via finish handler', async () => {
      // INSERT returns a row (claim successful)
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 } as any);
      // UPDATE for finish handler
      mockQuery.mockResolvedValue({ rows: [], rowCount: 1 } as any);

      await middleware(mockReq as Request, mockRes as unknown as Response, mockNext);

      // Simulate handler calling res.status(204).end() (bypasses res.json)
      (mockRes as any).statusCode = 204;
      mockRes.emit('finish');

      // Should have called UPDATE with status 204 and null body
      const updateCall = mockQuery.mock.calls.find(
        (call: any[]) =>
          typeof call[0] === 'string' &&
          call[0].includes('UPDATE idempotency_keys') &&
          call[0].includes('response_body = NULL')
      );
      expect(updateCall).toBeDefined();
      expect(updateCall![1][0]).toBe(204); // response_status
    });

    it('should clean up pending row on connection abort', async () => {
      // INSERT returns a row (claim successful)
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 } as any);
      // DELETE for cleanup
      mockQuery.mockResolvedValue({ rows: [], rowCount: 1 } as any);

      await middleware(mockReq as Request, mockRes as unknown as Response, mockNext);

      // Simulate connection abort (close event without writableFinished)
      (mockRes as any).writableFinished = false;
      mockRes.emit('close');

      // Should have called DELETE to clean up
      const deleteCall = mockQuery.mock.calls.find(
        (call: any[]) =>
          typeof call[0] === 'string' &&
          call[0].includes('DELETE FROM idempotency_keys') &&
          call[0].includes('response_status = 0')
      );
      expect(deleteCall).toBeDefined();
    });

    it('should not duplicate capture when res.json fires before finish', async () => {
      // INSERT returns a row (claim successful)
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 } as any);
      // UPDATE for json wrapper
      mockQuery.mockResolvedValue({ rows: [], rowCount: 1 } as any);

      await middleware(mockReq as Request, mockRes as unknown as Response, mockNext);

      // Handler calls res.json
      mockRes.json!({ ok: true });

      // Then finish fires
      (mockRes as any).statusCode = 200;
      const queryCountBeforeFinish = mockQuery.mock.calls.length;
      mockRes.emit('finish');
      const queryCountAfterFinish = mockQuery.mock.calls.length;

      // Finish handler should NOT make another query since _captured is true
      expect(queryCountAfterFinish).toBe(queryCountBeforeFinish);
    });

    it('should pass through on DB error during claim', async () => {
      // INSERT throws an error
      mockQuery.mockRejectedValueOnce(new Error('DB connection error'));

      await middleware(mockReq as Request, mockRes as unknown as Response, mockNext);

      // Should still proceed to handler (graceful degradation)
      expect(mockNext).toHaveBeenCalled();
    });
  });
});
