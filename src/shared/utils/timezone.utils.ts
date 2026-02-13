/**
 * Timezone utilities using Luxon for timezone-aware date/time operations.
 *
 * These helpers ensure consistent timezone handling across the application,
 * particularly for waiver processing and other scheduled operations.
 */

import { DateTime } from 'luxon';

/**
 * Day name to weekday number mapping for Luxon.
 * Luxon uses 1-7 (Monday-Sunday) while UTC uses 0-6 (Sunday-Saturday)
 */
const DAY_NAME_TO_LUXON_WEEKDAY: Record<string, number> = {
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
  sunday: 7,
};

/**
 * Convert UTC weekday (0-6, Sunday-Saturday) to Luxon weekday (1-7, Monday-Sunday)
 */
export function utcWeekdayToLuxonWeekday(utcWeekday: number): number {
  // UTC: 0=Sunday, 1=Monday, ..., 6=Saturday
  // Luxon: 1=Monday, 2=Tuesday, ..., 7=Sunday
  return utcWeekday === 0 ? 7 : utcWeekday;
}

/**
 * Convert day name (e.g., 'Wednesday') to Luxon weekday number (1-7)
 */
export function dayNameToWeekday(dayName: string): number {
  const normalized = dayName.toLowerCase();
  const weekday = DAY_NAME_TO_LUXON_WEEKDAY[normalized];

  if (!weekday) {
    throw new Error(`Invalid day name: ${dayName}. Expected one of: ${Object.keys(DAY_NAME_TO_LUXON_WEEKDAY).join(', ')}`);
  }

  return weekday;
}

/**
 * Calculate the next occurrence of a specific weekday and hour in a given timezone.
 *
 * @param targetWeekday - Luxon weekday number (1-7, Monday-Sunday)
 * @param targetHour - Hour of day (0-23)
 * @param timezone - IANA timezone name (e.g., 'America/New_York')
 * @returns Date object in UTC representing the next occurrence
 *
 * @example
 * // Calculate next Wednesday 3 AM Eastern Time
 * const nextWaiverDeadline = calculateNextOccurrence(3, 3, 'America/New_York');
 */
export function calculateNextOccurrence(
  targetWeekday: number,
  targetHour: number,
  timezone: string
): Date {
  // Start with current time in the league's timezone
  let dt = DateTime.now().setZone(timezone);

  // Set to target hour/minute (keep current day initially)
  dt = dt.set({ hour: targetHour, minute: 0, second: 0, millisecond: 0 });

  // Calculate days until target weekday
  let daysUntilTarget = targetWeekday - dt.weekday;
  if (daysUntilTarget < 0) {
    daysUntilTarget += 7;
  }

  // If target is today but time has passed, go to next week
  if (daysUntilTarget === 0 && dt < DateTime.now().setZone(timezone)) {
    daysUntilTarget = 7;
  }

  // Add days to reach target weekday
  dt = dt.plus({ days: daysUntilTarget });

  // Convert to UTC for database storage
  return dt.toUTC().toJSDate();
}

/**
 * Check if current time matches the target weekday and hour in a given timezone.
 *
 * @param targetWeekday - Luxon weekday number (1-7, Monday-Sunday)
 * @param targetHour - Hour of day (0-23)
 * @param timezone - IANA timezone name
 * @param toleranceMinutes - Allow matching within this many minutes of the target hour (default: 0)
 * @returns True if current time matches target time in the league's timezone
 *
 * @example
 * // Check if it's Wednesday 3 AM Eastern Time right now
 * const shouldProcess = isCurrentTimeMatch(3, 3, 'America/New_York');
 */
export function isCurrentTimeMatch(
  targetWeekday: number,
  targetHour: number,
  timezone: string,
  toleranceMinutes = 0
): boolean {
  const now = DateTime.now().setZone(timezone);
  const currentWeekday = now.weekday;
  const currentHour = now.hour;
  const currentMinute = now.minute;

  // Check weekday match
  if (currentWeekday !== targetWeekday) {
    return false;
  }

  // Check hour match with optional tolerance
  if (currentHour !== targetHour) {
    return false;
  }

  // If tolerance is 0, must be exact hour
  if (toleranceMinutes === 0) {
    return true;
  }

  // Check if within tolerance window
  return currentMinute < toleranceMinutes;
}

/**
 * Format a UTC date/time for display in a specific timezone.
 *
 * @param utcDate - Date object in UTC
 * @param timezone - IANA timezone name for display
 * @param format - Luxon format preset or custom format string
 * @returns Formatted date string in the league's timezone
 *
 * @example
 * const displayTime = formatInTimezone(waiverDeadline, 'America/New_York', 'DATETIME_FULL');
 * // Output: "Wednesday, January 15, 2026, 3:00 AM EST"
 */
export function formatInTimezone(
  utcDate: Date,
  timezone: string,
  format: 'DATE_SHORT' | 'DATE_MED' | 'DATE_FULL' | 'DATETIME_SHORT' | 'DATETIME_MED' | 'DATETIME_FULL' | string = 'DATETIME_FULL'
): string {
  const dt = DateTime.fromJSDate(utcDate, { zone: 'UTC' }).setZone(timezone);

  // Use Luxon preset if available, otherwise treat as custom format
  const presets = ['DATE_SHORT', 'DATE_MED', 'DATE_FULL', 'DATETIME_SHORT', 'DATETIME_MED', 'DATETIME_FULL'];
  if (presets.includes(format)) {
    return dt.toLocaleString(DateTime[format as keyof typeof DateTime] as any);
  }

  return dt.toFormat(format);
}

/**
 * Get the abbreviation for a timezone at a given time (accounts for DST).
 *
 * @param timezone - IANA timezone name
 * @param date - Optional date to check (defaults to now)
 * @returns Timezone abbreviation (e.g., 'EST', 'EDT', 'PST', 'PDT')
 */
export function getTimezoneAbbreviation(timezone: string, date?: Date): string {
  const dt = date
    ? DateTime.fromJSDate(date, { zone: 'UTC' }).setZone(timezone)
    : DateTime.now().setZone(timezone);

  return dt.offsetNameShort || timezone;
}

/**
 * Convert a UTC weekday/hour to a specific timezone weekday/hour.
 * Useful for migrating existing UTC-based settings to timezone-aware settings.
 *
 * @param utcWeekday - UTC weekday (0-6, Sunday-Saturday)
 * @param utcHour - UTC hour (0-23)
 * @param timezone - Target IANA timezone
 * @returns Object with timezone weekday (1-7) and hour
 */
export function convertUTCToTimezone(
  utcWeekday: number,
  utcHour: number,
  timezone: string
): { weekday: number; hour: number } {
  // Create a date in UTC representing the target weekday and hour
  const now = DateTime.utc();
  const luxonWeekday = utcWeekdayToLuxonWeekday(utcWeekday);

  // Calculate days until target weekday
  let daysUntilTarget = luxonWeekday - now.weekday;
  if (daysUntilTarget < 0) {
    daysUntilTarget += 7;
  }

  // Create UTC datetime for target
  const utcTarget = now
    .plus({ days: daysUntilTarget })
    .set({ hour: utcHour, minute: 0, second: 0, millisecond: 0 });

  // Convert to target timezone
  const tzTarget = utcTarget.setZone(timezone);

  return {
    weekday: tzTarget.weekday,
    hour: tzTarget.hour,
  };
}
