/**
 * Notification Controller
 * Stream C: Push Notifications (C1.5)
 */

import { Response } from 'express';
import { AuthRequest } from '../../middleware/auth.middleware';
import { NotificationService } from './notification.service';

export class NotificationController {
  constructor(private readonly notificationService: NotificationService) {}

  /**
   * GET /api/notifications/preferences
   * Get user's notification preferences
   */
  getPreferences = async (req: AuthRequest, res: Response) => {
    const userId = req.user!.userId;
    const prefs = await this.notificationService.getNotificationPreferences(userId);
    res.status(200).json(prefs);
  };

  /**
   * PUT /api/notifications/preferences
   * Update user's notification preferences
   */
  updatePreferences = async (req: AuthRequest, res: Response) => {
    const userId = req.user!.userId;
    const updates = req.body;

    const prefs = await this.notificationService.updateNotificationPreferences(userId, updates);
    res.status(200).json(prefs);
  };

  /**
   * POST /api/notifications/register-device
   * Register a device token for push notifications
   */
  registerDevice = async (req: AuthRequest, res: Response) => {
    const userId = req.user!.userId;
    const { token, device_type, device_name } = req.body;

    await this.notificationService.registerDeviceToken(
      userId,
      token,
      device_type,
      device_name
    );

    res.status(200).json({ message: 'Device registered successfully' });
  };

  /**
   * DELETE /api/notifications/unregister-device
   * Unregister a device token (scoped to the authenticated user)
   */
  unregisterDevice = async (req: AuthRequest, res: Response) => {
    const userId = req.user!.userId;
    const { token } = req.body;

    const result = await this.notificationService.unregisterDeviceToken(userId, token);
    res.status(200).json({ ok: true, changed: result.changed });
  };

  /**
   * POST /api/notifications/test
   * Send a test notification (development only)
   */
  sendTestNotification = async (req: AuthRequest, res: Response) => {
    const userId = req.user!.userId;

    const result = await this.notificationService.sendPushNotification(userId, {
      title: 'Test Notification',
      body: 'This is a test notification from HypeTrainFF',
      data: { type: 'test' },
    });

    res.status(200).json(result);
  };
}
