/**
 * Notification Service with Firebase Cloud Messaging
 * Stream C: Push Notifications (C1.4)
 */

import { Pool } from 'pg';
import { logger } from '../../config/logger.config';

// TODO: Implement Firebase Cloud Messaging push notifications (import firebase-admin)

export interface PushNotificationPayload {
  title: string;
  body: string;
  data?: Record<string, string>;
  imageUrl?: string;
}

export interface NotificationPreferences {
  userId: string;
  enabledPush: boolean;
  draftStart: boolean;
  draftYourTurn: boolean;
  draftCompleted: boolean;
  tradeOffers: boolean;
  tradeAccepted: boolean;
  tradeCountered: boolean;
  tradeVoted: boolean;
  tradeCompleted: boolean;
  waiverResults: boolean;
  waiverProcessing: boolean;
  waiverEndingSoon: boolean;
  lineupLocks: boolean;
  playerNews: boolean;
  breakingNews: boolean;
}

export class NotificationService {
  constructor(private readonly db: Pool) {
    // TODO: Implement Firebase Cloud Messaging push notifications (initialize Firebase Admin SDK)
  }

  /**
   * Send push notification to a single user
   */
  async sendPushNotification(
    userId: string,
    notification: PushNotificationPayload
  ): Promise<{ success: boolean; messageId?: string; error?: string }> {
    try {
      // Check user preferences
      const prefs = await this.getNotificationPreferences(userId);
      if (!prefs.enabledPush) {
        logger.debug(`Push notifications disabled for user ${userId}`);
        return { success: false, error: 'Push notifications disabled' };
      }

      // Get active device tokens for user
      const tokens = await this.getActiveDeviceTokens(userId);
      if (tokens.length === 0) {
        logger.warn(`No active device tokens for user ${userId}`);
        return { success: false, error: 'No device tokens registered' };
      }

      // Send to all user's devices
      const results = await this.sendToTokens(tokens, notification);

      // Clean up invalid tokens
      await this.removeInvalidTokens(results.invalidTokens);

      return {
        success: results.successCount > 0,
        messageId: results.messageIds[0],
      };
    } catch (error) {
      logger.error(`Failed to send push notification to user ${userId}: ${error}`);
      return { success: false, error: String(error) };
    }
  }

  /**
   * Send push notification to multiple users (batch)
   *
   * Uses batched queries for device tokens and notification preferences
   * to avoid N+1 query patterns when sending to many users.
   */
  async sendBatchNotifications(
    userIds: string[],
    notification: PushNotificationPayload
  ): Promise<{ successCount: number; failureCount: number }> {
    if (userIds.length === 0) {
      return { successCount: 0, failureCount: 0 };
    }

    let successCount = 0;
    let failureCount = 0;

    // Batch fetch preferences and tokens for all users (2 queries instead of 2N)
    const [prefsMap, tokenMap] = await Promise.all([
      this.getNotificationPreferencesForUsers(userIds),
      this.getActiveDeviceTokensForUsers(userIds),
    ]);

    // Process FCM sends in batches to avoid overwhelming FCM
    const BATCH_SIZE = 500;
    for (let i = 0; i < userIds.length; i += BATCH_SIZE) {
      const batch = userIds.slice(i, i + BATCH_SIZE);

      const results = await Promise.allSettled(
        batch.map(async (userId) => {
          try {
            // Check user preferences (from batch-fetched map)
            const prefs = prefsMap.get(userId);
            if (!prefs || !prefs.enabledPush) {
              logger.debug(`Push notifications disabled for user ${userId}`);
              return { success: false, error: 'Push notifications disabled' };
            }

            // Get tokens from batch-fetched map
            const tokens = tokenMap.get(userId) || [];
            if (tokens.length === 0) {
              logger.warn(`No active device tokens for user ${userId}`);
              return { success: false, error: 'No device tokens registered' };
            }

            // Send to all user's devices
            const sendResults = await this.sendToTokens(tokens, notification);

            // Clean up invalid tokens
            await this.removeInvalidTokens(sendResults.invalidTokens);

            return {
              success: sendResults.successCount > 0,
              messageId: sendResults.messageIds[0],
            };
          } catch (error) {
            logger.error(`Failed to send push notification to user ${userId}: ${error}`);
            return { success: false, error: String(error) };
          }
        })
      );

      results.forEach((result) => {
        if (result.status === 'fulfilled' && result.value.success) {
          successCount++;
        } else {
          failureCount++;
        }
      });
    }

    logger.info(`Batch notification sent: ${successCount} succeeded, ${failureCount} failed`);
    return { successCount, failureCount };
  }

  /**
   * Send notification to a topic (for league-wide broadcasts)
   */
  async sendToTopic(
    topic: string,
    notification: PushNotificationPayload
  ): Promise<{ success: boolean; messageId?: string }> {
    try {
      // TODO: Implement Firebase Cloud Messaging push notifications (topic messaging)
      logger.info(`Notification to topic ${topic} not yet implemented (FCM pending)`);
      return { success: true, messageId: 'placeholder-id' };
    } catch (error) {
      logger.error(`Failed to send notification to topic ${topic}: ${error}`);
      return { success: false };
    }
  }

  /**
   * Get notification preferences for a user
   */
  async getNotificationPreferences(userId: string): Promise<NotificationPreferences> {
    const result = await this.db.query(
      'SELECT * FROM notification_preferences WHERE user_id = $1',
      [userId]
    );

    if (result.rows.length === 0) {
      // Return default preferences
      return {
        userId,
        enabledPush: true,
        draftStart: true,
        draftYourTurn: true,
        draftCompleted: true,
        tradeOffers: true,
        tradeAccepted: true,
        tradeCountered: true,
        tradeVoted: true,
        tradeCompleted: true,
        waiverResults: true,
        waiverProcessing: true,
        waiverEndingSoon: true,
        lineupLocks: true,
        playerNews: true,
        breakingNews: true,
      };
    }

    const row = result.rows[0];
    return {
      userId: row.user_id,
      enabledPush: row.enabled_push,
      draftStart: row.draft_start,
      draftYourTurn: row.draft_your_turn,
      draftCompleted: row.draft_completed,
      tradeOffers: row.trade_offers,
      tradeAccepted: row.trade_accepted,
      tradeCountered: row.trade_countered,
      tradeVoted: row.trade_voted,
      tradeCompleted: row.trade_completed,
      waiverResults: row.waiver_results,
      waiverProcessing: row.waiver_processing,
      waiverEndingSoon: row.waiver_ending_soon,
      lineupLocks: row.lineup_locks,
      playerNews: row.player_news,
      breakingNews: row.breaking_news,
    };
  }

  /**
   * Batch fetch notification preferences for multiple users.
   *
   * Replaces N individual getNotificationPreferences calls with a single query.
   * Users without stored preferences receive defaults (all enabled).
   */
  private async getNotificationPreferencesForUsers(
    userIds: string[]
  ): Promise<Map<string, NotificationPreferences>> {
    if (userIds.length === 0) {
      return new Map();
    }

    const result = await this.db.query(
      'SELECT * FROM notification_preferences WHERE user_id = ANY($1)',
      [userIds]
    );

    const prefsMap = new Map<string, NotificationPreferences>();

    // Map rows by user_id for quick lookup
    const rowMap = new Map<string, any>();
    for (const row of result.rows) {
      rowMap.set(row.user_id, row);
    }

    // Build preferences for all requested users
    for (const userId of userIds) {
      const row = rowMap.get(userId);
      if (!row) {
        // Return default preferences for users without stored prefs
        prefsMap.set(userId, {
          userId,
          enabledPush: true,
          draftStart: true,
          draftYourTurn: true,
          draftCompleted: true,
          tradeOffers: true,
          tradeAccepted: true,
          tradeCountered: true,
          tradeVoted: true,
          tradeCompleted: true,
          waiverResults: true,
          waiverProcessing: true,
          waiverEndingSoon: true,
          lineupLocks: true,
          playerNews: true,
          breakingNews: true,
        });
      } else {
        prefsMap.set(userId, {
          userId: row.user_id,
          enabledPush: row.enabled_push,
          draftStart: row.draft_start,
          draftYourTurn: row.draft_your_turn,
          draftCompleted: row.draft_completed,
          tradeOffers: row.trade_offers,
          tradeAccepted: row.trade_accepted,
          tradeCountered: row.trade_countered,
          tradeVoted: row.trade_voted,
          tradeCompleted: row.trade_completed,
          waiverResults: row.waiver_results,
          waiverProcessing: row.waiver_processing,
          waiverEndingSoon: row.waiver_ending_soon,
          lineupLocks: row.lineup_locks,
          playerNews: row.player_news,
          breakingNews: row.breaking_news,
        });
      }
    }

    return prefsMap;
  }

  /**
   * Update notification preferences for a user
   */
  async updateNotificationPreferences(
    userId: string,
    preferences: Partial<NotificationPreferences>
  ): Promise<NotificationPreferences> {
    // Upsert preferences
    const result = await this.db.query(
      `INSERT INTO notification_preferences (
        user_id, enabled_push, draft_start, draft_your_turn, draft_completed,
        trade_offers, trade_accepted, trade_countered, trade_voted, trade_completed,
        waiver_results, waiver_processing, waiver_ending_soon,
        lineup_locks, player_news, breaking_news
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
      ON CONFLICT (user_id) DO UPDATE SET
        enabled_push = COALESCE($2, notification_preferences.enabled_push),
        draft_start = COALESCE($3, notification_preferences.draft_start),
        draft_your_turn = COALESCE($4, notification_preferences.draft_your_turn),
        draft_completed = COALESCE($5, notification_preferences.draft_completed),
        trade_offers = COALESCE($6, notification_preferences.trade_offers),
        trade_accepted = COALESCE($7, notification_preferences.trade_accepted),
        trade_countered = COALESCE($8, notification_preferences.trade_countered),
        trade_voted = COALESCE($9, notification_preferences.trade_voted),
        trade_completed = COALESCE($10, notification_preferences.trade_completed),
        waiver_results = COALESCE($11, notification_preferences.waiver_results),
        waiver_processing = COALESCE($12, notification_preferences.waiver_processing),
        waiver_ending_soon = COALESCE($13, notification_preferences.waiver_ending_soon),
        lineup_locks = COALESCE($14, notification_preferences.lineup_locks),
        player_news = COALESCE($15, notification_preferences.player_news),
        breaking_news = COALESCE($16, notification_preferences.breaking_news),
        updated_at = NOW()
      RETURNING *`,
      [
        userId,
        preferences.enabledPush,
        preferences.draftStart,
        preferences.draftYourTurn,
        preferences.draftCompleted,
        preferences.tradeOffers,
        preferences.tradeAccepted,
        preferences.tradeCountered,
        preferences.tradeVoted,
        preferences.tradeCompleted,
        preferences.waiverResults,
        preferences.waiverProcessing,
        preferences.waiverEndingSoon,
        preferences.lineupLocks,
        preferences.playerNews,
        preferences.breakingNews,
      ]
    );

    return this.getNotificationPreferences(userId);
  }

  /**
   * Register a device token for push notifications
   */
  async registerDeviceToken(
    userId: string,
    token: string,
    deviceType: 'ios' | 'android' | 'web',
    deviceName?: string
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO device_tokens (user_id, token, device_type, device_name, last_used_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (token) DO UPDATE SET
         user_id = EXCLUDED.user_id,
         device_type = EXCLUDED.device_type,
         device_name = COALESCE(EXCLUDED.device_name, device_tokens.device_name),
         last_used_at = NOW(),
         is_active = true,
         updated_at = NOW()`,
      [userId, token, deviceType, deviceName]
    );

    logger.info(`Device token registered for user ${userId} (${deviceType})`);
  }

  /**
   * Unregister a device token (scoped to the owning user)
   */
  async unregisterDeviceToken(userId: string, token: string): Promise<void> {
    await this.db.query(
      'UPDATE device_tokens SET is_active = false, updated_at = NOW() WHERE token = $1 AND user_id = $2',
      [token, userId]
    );
    logger.info(`Device token unregistered for user ${userId}`);
  }

  /**
   * Get active device tokens for a user
   */
  private async getActiveDeviceTokens(userId: string): Promise<string[]> {
    const result = await this.db.query(
      `SELECT token FROM device_tokens
       WHERE user_id = $1 AND is_active = true
       ORDER BY last_used_at DESC`,
      [userId]
    );
    return result.rows.map((row) => row.token);
  }

  /**
   * Batch fetch active device tokens for multiple users.
   *
   * Replaces N individual getActiveDeviceTokens calls with a single query.
   * Returns a Map of userId to their active tokens (ordered by last_used_at DESC).
   */
  private async getActiveDeviceTokensForUsers(userIds: string[]): Promise<Map<string, string[]>> {
    if (userIds.length === 0) {
      return new Map();
    }

    const result = await this.db.query(
      `SELECT user_id, token FROM device_tokens
       WHERE user_id = ANY($1) AND is_active = true
       ORDER BY user_id, last_used_at DESC`,
      [userIds]
    );

    const tokenMap = new Map<string, string[]>();

    // Initialize all requested userIds with empty arrays
    for (const userId of userIds) {
      tokenMap.set(userId, []);
    }

    // Populate with query results
    for (const row of result.rows) {
      const tokens = tokenMap.get(row.user_id);
      if (tokens) {
        tokens.push(row.token);
      }
    }

    return tokenMap;
  }

  /**
   * Send notification to multiple tokens
   */
  private async sendToTokens(
    tokens: string[],
    notification: PushNotificationPayload
  ): Promise<{ successCount: number; messageIds: string[]; invalidTokens: string[] }> {
    // TODO: Implement Firebase Cloud Messaging push notifications (multicast send)
    logger.info(`Sending notification to ${tokens.length} tokens not yet implemented (FCM pending)`);
    logger.debug(`Notification: ${notification.title} - ${notification.body}`);

    return {
      successCount: tokens.length,
      messageIds: tokens.map((_, i) => `msg-${i}`),
      invalidTokens: [],
    };
  }

  /**
   * Remove invalid/expired tokens from database
   */
  private async removeInvalidTokens(tokens: string[]): Promise<void> {
    if (tokens.length === 0) return;

    await this.db.query(
      'UPDATE device_tokens SET is_active = false WHERE token = ANY($1)',
      [tokens]
    );

    logger.info(`Removed ${tokens.length} invalid device tokens`);
  }
}
