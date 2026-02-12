/**
 * Notification Routes
 * Stream C: Push Notifications
 */

import { Router } from 'express';
import { Pool } from 'pg';
import { NotificationController } from './notification.controller';
import { NotificationService } from './notification.service';
import { authMiddleware } from '../../middleware/auth.middleware';
import { apiReadLimiter, apiWriteLimiter } from '../../middleware/rate-limit.middleware';
import { validateRequest } from '../../middleware/validation.middleware';
import { container, KEYS } from '../../container';
import {
  registerDeviceSchema,
  unregisterDeviceSchema,
  updatePreferencesSchema,
} from './notification.schemas';
import { asyncHandler } from '../../shared/async-handler';

const pool = container.resolve<Pool>(KEYS.POOL);
const notificationService = new NotificationService(pool);
const notificationController = new NotificationController(notificationService);

const router = Router();

// All notification routes require authentication
router.use(authMiddleware);

// GET /api/notifications/preferences - Get user preferences
router.get('/preferences', apiReadLimiter, asyncHandler(notificationController.getPreferences));

// PUT /api/notifications/preferences - Update preferences
router.put('/preferences', apiWriteLimiter, validateRequest(updatePreferencesSchema), asyncHandler(notificationController.updatePreferences));

// POST /api/notifications/register-device - Register FCM token
router.post('/register-device', apiWriteLimiter, validateRequest(registerDeviceSchema), asyncHandler(notificationController.registerDevice));

// DELETE /api/notifications/unregister-device - Unregister FCM token
router.delete('/unregister-device', apiWriteLimiter, validateRequest(unregisterDeviceSchema), asyncHandler(notificationController.unregisterDevice));

// POST /api/notifications/test - Send test notification (development)
if (process.env.NODE_ENV !== 'production') {
  router.post('/test', apiWriteLimiter, asyncHandler(notificationController.sendTestNotification));
}

export default router;
