import type { LeaderboardPeriod } from '@poker/shared';

/**
 * Which buckets a hand counts towards.
 *
 * Three, always: all time, the month it was played in, and the ISO week. The
 * keys are the strings that name both the Postgres rows and the Redis sorted
 * sets, so `lb:net:2026-W36` and the `player_stat_periods` row with
 * `period_key = '2026-W36'` are visibly the same thing.
 *
 * Everything here is UTC. A player in Auckland and a player in Los Angeles
 * finishing a hand in the same second must land in the same bucket, and the only
 * way to get that is for the boundary to belong to nobody's local midnight.
 *
 * Pure functions of a `Date`. No clock is read in this file — callers pass the
 * hand's own timestamp, which is what makes a replay or a rebuild land every
 * hand in the bucket it was actually played in rather than the one it is being
 * counted in.
 */

export const ALLTIME_KEY = 'alltime';

/** `2026-09`. */
export function monthKey(at: Date): string {
  const year = at.getUTCFullYear();
  const month = at.getUTCMonth() + 1;
  return `${String(year)}-${String(month).padStart(2, '0')}`;
}

/**
 * `2026-W36`, by ISO-8601 week numbering.
 *
 * Weeks run Monday to Sunday and week 1 is the one containing the first
 * Thursday of the year, which is why the year in the key is not always the
 * calendar year of the date: 1 January 2027 is a Friday, and belongs to
 * `2026-W53`. Getting that wrong is how a week's board briefly loses everybody.
 */
export function isoWeekKey(at: Date): string {
  // Move to the Thursday of this date's week. Whatever year that Thursday is
  // in is, by definition, the ISO week-numbering year.
  const thursday = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  const isoDay = thursday.getUTCDay() === 0 ? 7 : thursday.getUTCDay();
  thursday.setUTCDate(thursday.getUTCDate() + 4 - isoDay);

  const yearStart = Date.UTC(thursday.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((thursday.getTime() - yearStart) / 86_400_000 + 1) / 7);

  return `${String(thursday.getUTCFullYear())}-W${String(week).padStart(2, '0')}`;
}

/** The month and week keys a hand played at `at` belongs to. All-time is implicit. */
export function periodKeysFor(at: Date): readonly string[] {
  return [monthKey(at), isoWeekKey(at)];
}

/** Which key a reader asking for a period wants, as of `now`. */
export function periodKeyFor(period: LeaderboardPeriod, now: Date): string {
  switch (period) {
    case 'alltime':
      return ALLTIME_KEY;
    case 'month':
      return monthKey(now);
    case 'week':
      return isoWeekKey(now);
  }
}

/** True for a weekly key, which is the only kind that expires. */
export function isWeekKey(periodKey: string): boolean {
  return /^\d{4}-W\d{2}$/.test(periodKey);
}

/**
 * How long a weekly sorted set is kept.
 *
 * Sixty days is long enough that last week's board is still there for anybody
 * who wants to look back, and short enough that a year of weekly keys does not
 * quietly become the largest thing in Redis.
 */
export const WEEK_TTL_SECONDS = 60 * 24 * 60 * 60;
