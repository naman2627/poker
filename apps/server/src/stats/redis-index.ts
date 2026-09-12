import type Redis from 'ioredis';
import { MIN_RANKED_HANDS, handCategoryRank, type LeaderboardMetric } from '@poker/shared';
import type { StatCounters } from './delta';
import { ALL_METRICS, leaderboardKey, stagingKey } from './keys';
import { WEEK_TTL_SECONDS, isWeekKey } from './periods';
import type { AppliedHand, LeaderboardIndex } from './ports';

/**
 * The boards, as Redis sorted sets.
 *
 * A mirror and never a truth. Everything in here can be thrown away — evicted,
 * flushed, or simply never written because Redis was down when the hand ended —
 * and `rebuildLeaderboards()` puts it back from `player_stats`. That is the
 * whole reason the write path below is allowed to be best-effort.
 *
 * Three kinds of score, three ways of moving them:
 *
 *   ZINCRBY   net chips and hands played. They are running totals, so the delta
 *             is the whole update and no read is needed. This is the operation
 *             the sorted set exists for.
 *   ZADD GT   the biggest pot and the best hand. Maxima, not totals: `GT` only
 *             raises a score, so two hands landing out of order cannot lower a
 *             record that already stands.
 *   ZADD      win rate and BB/100, recomputed from the totals the transaction
 *             just returned. A ratio cannot be incremented, and the totals are
 *             already in hand, so there is nothing to read either.
 *
 * THE THRESHOLD is enforced here as membership rather than as a filter: a player
 * under `MIN_RANKED_HANDS` is simply not a member of the two rate sets. They
 * cannot appear in a `ZREVRANGE`, they have no `ZREVRANK`, and no read path has
 * to remember to exclude them. When they cross two hundred hands they are added
 * like anybody else.
 *
 * Reads are `ZREVRANGE key 0 49 WITHSCORES` for the board and `ZREVRANK` for
 * "your rank". Neither of them touches `hand_actions`, and neither of them
 * sorts anything at request time.
 */
export function createRedisLeaderboardIndex(redis: Redis): LeaderboardIndex {
  return {
    async mirror(applied: AppliedHand): Promise<void> {
      if (applied.entries.length === 0) return;

      const pipeline = redis.multi();

      for (const entry of applied.entries) {
        const { userId, periodKey, delta, counters } = entry;

        // Running totals. ZINCRBY is the point of the exercise: no read, no
        // race, and two hands landing at once both count.
        pipeline.zincrby(leaderboardKey('net', periodKey), delta.netChips, userId);
        pipeline.zincrby(leaderboardKey('hands', periodKey), delta.handsPlayed, userId);

        // Maxima. `GT` refuses to lower an existing score, which is exactly the
        // rule — a record is a record however late the write arrives.
        if (delta.potWon > 0) {
          pipeline.zadd(leaderboardKey('biggestPot', periodKey), 'GT', delta.potWon, userId);
        }
        if (delta.shownCategory !== null) {
          pipeline.zadd(
            leaderboardKey('bestHand', periodKey),
            'GT',
            handCategoryRank(delta.shownCategory),
            userId,
          );
        }

        // Rates, from the totals the transaction handed back. Below the
        // threshold nothing is written, so the member never appears.
        if (counters.handsPlayed >= MIN_RANKED_HANDS) {
          pipeline.zadd(leaderboardKey('winRate', periodKey), rateOf('winRate', counters), userId);
          pipeline.zadd(leaderboardKey('bb100', periodKey), rateOf('bb100', counters), userId);
        }

        // A weekly board is kept for sixty days. Re-setting the TTL on every
        // write means the clock starts from the last hand played in that week
        // rather than from whenever the key happened to be created.
        if (isWeekKey(periodKey)) {
          for (const metric of ALL_METRICS) {
            pipeline.expire(leaderboardKey(metric, periodKey), WEEK_TTL_SECONDS);
          }
        }
      }

      await pipeline.exec();
    },

    /**
     * Swap one board for a freshly built one.
     *
     * Built into a staging key and renamed over the top, because a board that
     * was deleted and refilled would be empty or half-populated for as long as
     * the fill took. `RENAME` is atomic, so a reader sees the old board or the
     * new one and never a partial one.
     *
     * An empty board is the one case `RENAME` cannot express — Redis has no
     * empty sorted set — so it is a delete instead, which is the same thing.
     */
    async replace(
      metric: LeaderboardMetric,
      periodKey: string,
      entries: readonly { userId: string; score: number }[],
    ): Promise<void> {
      const live = leaderboardKey(metric, periodKey);
      const staging = stagingKey(metric, periodKey);

      if (entries.length === 0) {
        await redis.del(live, staging);
        return;
      }

      const pipeline = redis.multi();
      pipeline.del(staging);

      // Chunked: one ZADD with fifty thousand members is a long block on a
      // single-threaded server, and nothing here is in a hurry.
      for (const chunk of chunks(entries, 500)) {
        const args: (string | number)[] = [];
        for (const entry of chunk) args.push(entry.score, entry.userId);
        pipeline.zadd(staging, ...args);
      }

      pipeline.rename(staging, live);
      if (isWeekKey(periodKey)) pipeline.expire(live, WEEK_TTL_SECONDS);

      await pipeline.exec();
    },

    async top(
      metric: LeaderboardMetric,
      periodKey: string,
      limit: number,
    ): Promise<{ userId: string; score: number }[]> {
      const flat = await redis.zrevrange(
        leaderboardKey(metric, periodKey),
        0,
        Math.max(0, limit - 1),
        'WITHSCORES',
      );

      const found: { userId: string; score: number }[] = [];
      for (let index = 0; index + 1 < flat.length; index += 2) {
        const userId = flat[index];
        const score = Number(flat[index + 1]);
        if (userId !== undefined && Number.isFinite(score)) found.push({ userId, score });
      }
      return found;
    },

    async rank(
      userId: string,
      metric: LeaderboardMetric,
      periodKey: string,
    ): Promise<number | null> {
      const zeroBased = await redis.zrevrank(leaderboardKey(metric, periodKey), userId);
      return zeroBased === null ? null : zeroBased + 1;
    },

    async healthy(): Promise<boolean> {
      try {
        await redis.ping();
        return true;
      } catch {
        return false;
      }
    },

    close: () => Promise.resolve(),
  };
}

/** The score a rate metric carries. Mirrors `bbPer100` and `winRatePercent`. */
function rateOf(metric: 'winRate' | 'bb100', counters: StatCounters): number {
  if (metric === 'winRate') {
    return counters.handsPlayed === 0 ? 0 : (counters.handsWon / counters.handsPlayed) * 100;
  }
  // net / (bbSum / hands) / hands * 100 — the two `hands` cancel out.
  return counters.bigBlindSum === 0 ? 0 : (counters.netChips / counters.bigBlindSum) * 100;
}

function* chunks<T>(items: readonly T[], size: number): Generator<readonly T[]> {
  for (let index = 0; index < items.length; index += size) {
    yield items.slice(index, index + size);
  }
}
