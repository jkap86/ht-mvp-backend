/**
 * Notification Controller
 * Stream C: Push Notifications (C1.5)
 */

import { Response, NextFunction } from 'express';
import { AuthRequest } from '../../middleware/auth.middleware';
import { NotificationService } from './notification.service';

export class NotificationController {
  constructor(private readonly notificationService: NotificationService) {}

  /**
   * GET /api/notifications/preferences
   * Get user's notification preferences
   */
  getPreferences = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.id;
      const prefs = await this.notificationService.getNotificationPreferences(userId);
      res.status(200).json(prefs);
    } catch (error) {
      next(error);
    }
  };

  /**
   * PUT /api/notifications/preferences
   * Update user's notification preferences
   */
  updatePreferences = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.id;
      const updates = req.body;

      const prefs = await this.notificationService.updateNotificationPreferences(userId, updates);
      res.status(200).json(prefs);
    } catch (error) {
      next(error);
    }
  };

  /**
   * POST /api/notifications/register-device
   * Register a device token for push notifications
   */
  registerDevice = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.id;
      const { token, device_type, device_name } = req.body;

      if (!token || !device_type) {
        return res.status(400).json({ error: 'token and device_type are required' });
      }

      if (!['ios', 'android', 'web'].includes(device_type)) {
        return res.status(400).json({ error: 'Invalid device_type' });
      }

      await this.notificationService.registerDeviceToken(
        userId,
        token,
        device_type,
        device_name
      );

      res.status(200).json({ message: 'Device registered successfully' });
    } catch (error) {
      next(error);
    }
  };

  /**
   * DELETE /api/notifications/unregister-device
   * Unregister a device token
   */
  unregisterDevice = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { token } = req.body;

      if (!token) {
        return res.status(400).json({ error: 'token is required' });
      }

      await this.notificationService.unregisterDeviceToken(token);
      res.status(200).json({ message: 'Device unregistered successfully' });
    } catch (error) {
      next(error);
    }
  };

  /**
   * POST /api/notifications/test
   * Send a test notification (development only)
   */
  sendTestNotification = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.id;

      const result = await this.notificationService.sendPushNotification(userId, {
        title: 'Test Notification',
        body: 'This is a test notification from HypeTrainFF',
        data: { type: 'test' },
      });

      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  };
}
