/**
 * Utility functions for detecting NFL game windows
 * Used to determine optimal sync intervals for live scoring
 */

/**
 * NFL game window times in Eastern Time
 * These are approximate windows when games are typically in progress
 */
const GAME_WINDOWS = {
  // Thursday Night Football: ~8:15 PM - 11:30 PM ET
  THURSDAY: {
    dayOfWeek: 4, // Thursday
    startHour: 20, // 8 PM
    startMinute: 0,
    endHour: 23,
    endMinute: 30,
  },
  // Sunday games: ~1:00 PM - 11:30 PM ET (early, late, SNF)
  SUNDAY: {
    dayOfWeek: 0, // Sunday
    startHour: 13, // 1 PM
    startMinute: 0,
    endHour: 23,
    endMinute: 30,
  },
  // Monday Night Football: ~8:15 PM - 11:30 PM ET
  MONDAY: {
    dayOfWeek: 1, // Monday
    startHour: 20, // 8 PM
    startMinute: 0,
    endHour: 23,
    endMinute: 30,
  },
  // Saturday games (late season/playoffs): ~1:00 PM - 11:30 PM ET
  SATURDAY: {
    dayOfWeek: 6, // Saturday
    startHour: 13, // 1 PM
    startMinute: 0,
    endHour: 23,
    endMinute: 30,
  },
};

// Sync intervals in milliseconds
const LIVE_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes during games
const OFF_INTERVAL_MS = 60 * 60 * 1000; // 60 minutes when no games

/**
 * Get current time in Eastern Time
 */
function getCurrentTimeET(): { dayOfWeek: number; hour: number; minute: number } {
  const now = new Date();
  const etString = now.toLocaleString('en-US', { timeZone: 'America/New_York' });
  const etDate = new Date(etString);

  return {
    dayOfWeek: etDate.getDay(),
    hour: etDate.getHours(),
    minute: etDate.getMinutes(),
  };
}

/**
 * Check if a time is within a game window
 */
function isInWindow(
  time: { hour: number; minute: number },
  window: { startHour: number; startMinute: number; endHour: number; endMinute: number }
): boolean {
  const currentMinutes = time.hour * 60 + time.minute;
  const startMinutes = window.startHour * 60 + window.startMinute;
  const endMinutes = window.endHour * 60 + window.endMinute;

  return currentMinutes >= startMinutes && currentMinutes <= endMinutes;
}

/**
 * Check if current time is within an NFL game window
 * @returns true if games are likely in progress
 */
export function isInGameWindow(): boolean {
  const now = getCurrentTimeET();

  // Check each game window
  for (const window of Object.values(GAME_WINDOWS)) {
    if (now.dayOfWeek === window.dayOfWeek && isInWindow(now, window)) {
      return true;
    }
  }

  return false;
}

/**
 * Get the optimal sync interval based on whether games are in progress
 * @returns Interval in milliseconds (2 min during games, 60 min otherwise)
 */
export function getOptimalSyncInterval(): number {
  return isInGameWindow() ? LIVE_INTERVAL_MS : OFF_INTERVAL_MS;
}

/**
 * Get sync interval for a specific use case
 */
export const SYNC_INTERVALS = {
  LIVE: LIVE_INTERVAL_MS,
  OFF: OFF_INTERVAL_MS,
};
