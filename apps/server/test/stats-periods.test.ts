/**
 * Which bucket a hand lands in.
 *
 * The ISO week is the part worth testing hard: it is the one piece of date
 * arithmetic here that is easy to write plausibly and wrongly, and getting it
 * wrong loses a whole week's board for a few days every January.
 */
import { describe, expect, it } from 'vitest';
import {
  ALLTIME_KEY,
  WEEK_TTL_SECONDS,
  isWeekKey,
  isoWeekKey,
  monthKey,
  periodKeyFor,
  periodKeysFor,
} from '../src/stats/periods';

const at = (iso: string): Date => new Date(iso);

describe('monthKey', () => {
  it('pads the month', () => {
    expect(monthKey(at('2026-09-12T10:00:00Z'))).toBe('2026-09');
    expect(monthKey(at('2026-12-31T23:59:59Z'))).toBe('2026-12');
  });

  it('is UTC, not local', () => {
    // 23:30 on the 31st in UTC is already October in Auckland. Both players
    // must land in the same bucket, and UTC is the one that belongs to nobody.
    expect(monthKey(at('2026-08-31T23:30:00Z'))).toBe('2026-08');
  });
});

describe('isoWeekKey', () => {
  it('numbers the ordinary case', () => {
    // 12 September 2026 is a Saturday in ISO week 37.
    expect(isoWeekKey(at('2026-09-12T12:00:00Z'))).toBe('2026-W37');
  });

  it('runs Monday to Sunday', () => {
    // The Sunday and the Monday either side of it are different weeks.
    expect(isoWeekKey(at('2026-09-06T12:00:00Z'))).toBe('2026-W36');
    expect(isoWeekKey(at('2026-09-07T12:00:00Z'))).toBe('2026-W37');
  });

  it('puts early January in the previous year when ISO says so', () => {
    // 1 January 2027 is a Friday, so it belongs to the last week of 2026.
    expect(isoWeekKey(at('2027-01-01T12:00:00Z'))).toBe('2026-W53');
    expect(isoWeekKey(at('2027-01-03T12:00:00Z'))).toBe('2026-W53');
    // The Monday after is week 1 of 2027.
    expect(isoWeekKey(at('2027-01-04T12:00:00Z'))).toBe('2027-W01');
  });

  it('puts late December in the next year when ISO says so', () => {
    // 31 December 2024 is a Tuesday, in the first week of 2025.
    expect(isoWeekKey(at('2024-12-30T12:00:00Z'))).toBe('2025-W01');
  });

  it('always pads to two digits', () => {
    expect(isoWeekKey(at('2026-01-05T12:00:00Z'))).toBe('2026-W02');
  });
});

describe('periodKeysFor', () => {
  it('gives the month and the week, and leaves all-time implicit', () => {
    expect(periodKeysFor(at('2026-09-12T12:00:00Z'))).toEqual(['2026-09', '2026-W37']);
  });
});

describe('periodKeyFor', () => {
  const now = at('2026-09-12T12:00:00Z');

  it('maps the tab a reader picked onto a key', () => {
    expect(periodKeyFor('alltime', now)).toBe(ALLTIME_KEY);
    expect(periodKeyFor('month', now)).toBe('2026-09');
    expect(periodKeyFor('week', now)).toBe('2026-W37');
  });
});

describe('isWeekKey', () => {
  it('recognises only a weekly key, because only those expire', () => {
    expect(isWeekKey('2026-W37')).toBe(true);
    expect(isWeekKey('2026-09')).toBe(false);
    expect(isWeekKey(ALLTIME_KEY)).toBe(false);
  });

  it('keeps a week for sixty days', () => {
    expect(WEEK_TTL_SECONDS).toBe(60 * 24 * 60 * 60);
  });
});
