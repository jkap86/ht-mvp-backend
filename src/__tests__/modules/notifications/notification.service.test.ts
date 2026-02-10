import { NotificationService } from '../../../modules/notifications/notification.service';
import {
  registerDeviceSchema,
  unregisterDeviceSchema,
  updatePreferencesSchema,
} from '../../../modules/notifications/notification.schemas';

// Mock pool that captures queries
const createMockPool = () => {
  const queries: { text: string; values: unknown[] }[] = [];
  return {
    queries,
    query: jest.fn(async (text: string, values?: unknown[]) => {
      queries.push({ text, values: values || [] });
      return { rows: [], rowCount: 0 };
    }),
  };
};

describe('NotificationService', () => {
  describe('registerDeviceToken', () => {
    it('should reassign token ownership when same token registered by different user', async () => {
      const mockPool = createMockPool();
      const service = new NotificationService(mockPool as any);

      // User A registers token
      await service.registerDeviceToken('user-a', 'shared-token', 'ios', 'iPhone');

      // User B registers same token
      await service.registerDeviceToken('user-b', 'shared-token', 'android', 'Pixel');

      // Both calls should include user_id = EXCLUDED.user_id in the UPSERT
      expect(mockPool.queries).toHaveLength(2);

      const firstQuery = mockPool.queries[0].text;
      expect(firstQuery).toContain('user_id = EXCLUDED.user_id');
      expect(firstQuery).toContain('ON CONFLICT (token) DO UPDATE');
      expect(mockPool.queries[0].values[0]).toBe('user-a');

      const secondQuery = mockPool.queries[1].text;
      expect(secondQuery).toContain('user_id = EXCLUDED.user_id');
      expect(mockPool.queries[1].values[0]).toBe('user-b');
    });

    it('should update device_type and device_name on conflict', async () => {
      const mockPool = createMockPool();
      const service = new NotificationService(mockPool as any);

      await service.registerDeviceToken('user-a', 'token-1', 'ios', 'iPhone');

      const query = mockPool.queries[0].text;
      expect(query).toContain('device_type = EXCLUDED.device_type');
      expect(query).toContain('COALESCE(EXCLUDED.device_name');
    });
  });

  describe('unregisterDeviceToken', () => {
    it('should scope deactivation to the requesting user', async () => {
      const mockPool = createMockPool();
      const service = new NotificationService(mockPool as any);

      await service.unregisterDeviceToken('user-a', 'some-token');

      expect(mockPool.queries).toHaveLength(1);
      const query = mockPool.queries[0];
      expect(query.text).toContain('user_id = $2');
      expect(query.values).toEqual(['some-token', 'user-a']);
    });

    it('should not affect tokens owned by other users', async () => {
      const mockPool = createMockPool();
      const service = new NotificationService(mockPool as any);

      // User B tries to unregister user A's token — SQL includes user_id filter
      await service.unregisterDeviceToken('user-b', 'user-a-token');

      const query = mockPool.queries[0];
      // The WHERE clause includes both token AND user_id
      expect(query.text).toMatch(/WHERE\s+token\s*=\s*\$1\s+AND\s+user_id\s*=\s*\$2/);
      expect(query.values[1]).toBe('user-b');
    });
  });
});

describe('Notification Schemas', () => {
  describe('registerDeviceSchema', () => {
    it('should accept valid input', () => {
      const result = registerDeviceSchema.safeParse({
        token: 'fcm-token-abc123',
        device_type: 'ios',
        device_name: 'My iPhone',
      });
      expect(result.success).toBe(true);
    });

    it('should reject missing token', () => {
      const result = registerDeviceSchema.safeParse({
        device_type: 'ios',
      });
      expect(result.success).toBe(false);
    });

    it('should reject invalid device_type', () => {
      const result = registerDeviceSchema.safeParse({
        token: 'fcm-token',
        device_type: 'windows',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('unregisterDeviceSchema', () => {
    it('should accept valid token', () => {
      const result = unregisterDeviceSchema.safeParse({ token: 'fcm-token-abc123' });
      expect(result.success).toBe(true);
    });

    it('should reject empty token', () => {
      const result = unregisterDeviceSchema.safeParse({ token: '' });
      expect(result.success).toBe(false);
    });
  });

  describe('updatePreferencesSchema', () => {
    it('should accept valid boolean preferences', () => {
      const result = updatePreferencesSchema.safeParse({
        enabledPush: false,
        tradeOffers: true,
      });
      expect(result.success).toBe(true);
    });

    it('should reject unknown fields', () => {
      const result = updatePreferencesSchema.safeParse({
        enabledPush: true,
        hackField: true,
      });
      expect(result.success).toBe(false);
    });

    it('should reject non-boolean values for preference fields', () => {
      const result = updatePreferencesSchema.safeParse({
        enabledPush: 'yes',
      });
      expect(result.success).toBe(false);
    });

    it('should accept empty object (no changes)', () => {
      const result = updatePreferencesSchema.safeParse({});
      expect(result.success).toBe(true);
    });
  });
});
