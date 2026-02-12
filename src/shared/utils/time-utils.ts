/**
 * Time utility functions for overnight pause window handling
 */

/**
 * Check if the current time falls within a pause window.
 * Handles cases where the window spans midnight (e.g., 23:00 to 06:00).
 *
 * @param now - Current time to check (defaults to now)
 * @param startTime - Start time in HH:MM format (e.g., "23:00")
 * @param endTime - End time in HH:MM format (e.g., "08:00")
 * @returns true if current time is within the pause window
 *
 * @example
 * // Window from 11 PM to 8 AM (spans midnight)
 * isInPauseWindow(new Date('2026-02-12T23:30:00Z'), '23:00', '08:00') // true
 * isInPauseWindow(new Date('2026-02-12T03:00:00Z'), '23:00', '08:00') // true
 * isInPauseWindow(new Date('2026-02-12T10:00:00Z'), '23:00', '08:00') // false
 *
 * @example
 * // Window from 2 AM to 6 AM (same day)
 * isInPauseWindow(new Date('2026-02-12T03:00:00Z'), '02:00', '06:00') // true
 * isInPauseWindow(new Date('2026-02-12T01:00:00Z'), '02:00', '06:00') // false
 */
export function isInPauseWindow(
  now: Date = new Date(),
  startTime: string,
  endTime: string
): boolean {
  // Parse time strings (format: HH:MM)
  const [startHour, startMinute] = startTime.split(':').map(Number);
  const [endHour, endMinute] = endTime.split(':').map(Number);

  // Get current time in minutes since midnight UTC
  const currentMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const startMinutes = startHour * 60 + startMinute;
  const endMinutes = endHour * 60 + endMinute;

  // Check if window spans midnight
  if (endMinutes < startMinutes) {
    // Window spans midnight (e.g., 23:00 to 08:00)
    // Current time is in window if it's after start OR before end
    return currentMinutes >= startMinutes || currentMinutes < endMinutes;
  } else {
    // Window is within same day (e.g., 02:00 to 06:00)
    // Current time is in window if it's between start and end
    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  }
}

/**
 * Convert a time string to minutes since midnight.
 * Used for comparing time values.
 *
 * @param timeStr - Time in HH:MM format
 * @returns Minutes since midnight
 */
export function timeToMinutes(timeStr: string): number {
  const [hour, minute] = timeStr.split(':').map(Number);
  return hour * 60 + minute;
}

/**
 * Format a Date object to HH:MM string in UTC.
 *
 * @param date - Date to format
 * @returns Time string in HH:MM format
 */
export function formatTimeUTC(date: Date): string {
  const hours = date.getUTCHours().toString().padStart(2, '0');
  const minutes = date.getUTCMinutes().toString().padStart(2, '0');
  return `${hours}:${minutes}`;
}

/**
 * Calculate the next time a pause window will start or end.
 * Useful for displaying countdown timers.
 *
 * @param now - Current time
 * @param targetTime - Target time in HH:MM format
 * @returns Date object representing the next occurrence of targetTime
 */
export function getNextOccurrence(now: Date, targetTime: string): Date {
  const [targetHour, targetMinute] = targetTime.split(':').map(Number);

  const next = new Date(now);
  next.setUTCHours(targetHour, targetMinute, 0, 0);

  // If target time has already passed today, move to tomorrow
  if (next <= now) {
    next.setUTCDate(next.getUTCDate() + 1);
  }

  return next;
}
