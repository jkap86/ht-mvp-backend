/**
 * Firebase Admin SDK initialization.
 *
 * Reads credentials from FIREBASE_SERVICE_ACCOUNT_JSON (inline JSON string)
 * or falls back to GOOGLE_APPLICATION_CREDENTIALS (path to service account file).
 */

import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getMessaging, Messaging } from 'firebase-admin/messaging';
import { logger } from '../config/logger.config';

let messagingInstance: Messaging | null = null;

export function initFirebase(): void {
  if (getApps().length > 0) return;

  try {
    const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

    if (serviceAccountJson) {
      const serviceAccount = JSON.parse(serviceAccountJson);
      initializeApp({ credential: cert(serviceAccount) });
    } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      // firebase-admin auto-discovers the file from this env var
      initializeApp();
    } else {
      logger.warn(
        'Firebase not configured: set FIREBASE_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS'
      );
      return;
    }

    messagingInstance = getMessaging();
    logger.info('Firebase Admin SDK initialized');
  } catch (error) {
    logger.error(`Failed to initialize Firebase Admin SDK: ${error}`);
  }
}

/**
 * Get the Firebase Messaging instance.
 * Returns null if Firebase is not configured.
 */
export function getFirebaseMessaging(): Messaging | null {
  return messagingInstance;
}
