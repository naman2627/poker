import { MIN_RANKED_HANDS, handCategoryRank, type LeaderboardMetric } from '@poker/shared';
import type { StatCounters } from './delta';
import { leaderboardKey } from './keys';
import type { AppliedHand, LeaderboardIndex } from './ports';

/**
 * The sorted sets, as Maps.
 *
 * Same purpose as every other memory adapter here: the product comes up with no
 * Redis, and the tests exercise the real read path rather than a special case.
 *
 * It is held to the same rules as the Redis one, and for the same reasons —
 * `ZINCRBY` becomes "add to what is there", `ZADD GT` becomes "keep the larger",
 * and a player under `MIN_RANKED_HANDS` is not a member of a rate board at all,
 * so the threshold is enforced by absence here too rather than by a filter the
 * reader has to remember.
 *
 * TTLs are not modelled. A process that will not outlive the week has nothing
 * to gain from expiring a weekly key, and pretending otherwise would be a timer
 * whose only effect is to make a test flaky.
 */
export function createMemoryLeaderboardIndex(): LeaderboardIndex {
  /** key -> userId -> score. */
  const sets = new Map<string, Map<string, number>>();

  const setFor = (metric: LeaderboardMetric, periodKey: string): Map<string, number> => {
    const key = leaderboardKey(metric, periodKey);
    const existing = sets.get(key);
    if (existing) return existing;
    const created = new Map<string, number>();
    sets.set(key, created);
    return created;
  };

  const sorted = (metric: LeaderboardMetric, periodKey: string): [string, number][] =>
    [...setFor(metric, periodKey)].sort((a, b) => {
      // Score descending; Redis breaks a tie by member, ascending. Matching that
      // is what makes a rank from this index and a rank from Redis agree.
      if (b[1] !== a[1]) return b[1] - a[1];
      return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
    });

  return {
    mirror(applied: AppliedHand): Promise<void> {
      for (const { userId, periodKey, delta, counters } of applied.entries) {
        const net = setFor('net', periodKey);
        net.set(userId, (net.get(userId) ?? 0) + delta.netChips);

        const played = setFor('hands', periodKey);
        played.set(userId, (played.get(userId) ?? 0) + delta.handsPlayed);

        if (delta.potWon > 0) {
          const pots = setFor('biggestPot', periodKey);
          pots.set(userId, Math.max(pots.get(userId) ?? 0, delta.potWon));
        }

        if (delta.shownCategory !== null) {
          const best = setFor('bestHand', periodKey);
          const rank = handCategoryRank(delta.shownCategory);
          best.set(userId, Math.max(best.get(userId) ?? 0, rank));
        }

        if (counters.handsPlayed >= MIN_RANKED_HANDS) {
          setFor('winRate', periodKey).set(userId, rateOf('winRate', counters));
          setFor('bb100', periodKey).set(userId, rateOf('bb100', counters));
        }
      }

      return Promise.resolve();
    },

    replace(
      metric: LeaderboardMetric,
      periodKey: string,
      entries: readonly { userId: string; score: number }[],
    ): Promise<void> {
      sets.set(
        leaderboardKey(metric, periodKey),
        new Map(entries.map((entry) => [entry.userId, entry.score])),
      );
      return Promise.resolve();
    },

    top(
      metric: LeaderboardMetric,
      periodKey: string,
      limit: number,
    ): Promise<{ userId: string; score: number }[]> {
      return Promise.resolve(
        sorted(metric, periodKey)
          .slice(0, limit)
          .map(([userId, score]) => ({ userId, score })),
      );
    },

    rank(userId: string, metric: LeaderboardMetric, periodKey: string): Promise<number | null> {
      const position = sorted(metric, periodKey).findIndex(([member]) => member === userId);
      return Promise.resolve(position === -1 ? null : position + 1);
    },

    healthy: () => Promise.resolve(true),
    close: () => Promise.resolve(),
  };
}

function rateOf(metric: 'winRate' | 'bb100', counters: StatCounters): number {
  if (metric === 'winRate') {
    return counters.handsPlayed === 0 ? 0 : (counters.handsWon / counters.handsPlayed) * 100;
  }
  return counters.bigBlindSum === 0 ? 0 : (counters.netChips / counters.bigBlindSum) * 100;
}
