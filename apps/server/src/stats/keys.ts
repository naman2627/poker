import type { LeaderboardMetric } from '@poker/shared';

/**
 * What the sorted sets are called.
 *
 *   lb:net:alltime        every hand ever
 *   lb:net:2026-09        a month
 *   lb:net:2026-W36       an ISO week, kept for sixty days
 *
 * and the same shape for the other five metrics. Naming them from the metric
 * and the period key rather than by hand means a new period needs no code: the
 * key falls out of the date the hand was played on.
 *
 * The scores are in the units the board shows, so a `ZREVRANGE … WITHSCORES` is
 * the answer rather than the input to one:
 *
 *   net          chips, signed, ZINCRBY on every hand
 *   hands        hands played, ZINCRBY 1 on every hand
 *   biggestPot   the largest single pot won — a maximum, so ZADD GT
 *   bestHand     1 for a high card to 9 for a straight flush — also ZADD GT
 *   winRate      percent, recomputed from the row's new totals
 *   bb100        big blinds per hundred hands, likewise
 *
 * The last two carry members only once the player has passed
 * `MIN_RANKED_HANDS`, which is how "not ranked until two hundred hands" is
 * enforced at the index rather than filtered out afterwards: an unqualified
 * player is not in the set, so they cannot be in a top fifty and cannot have a
 * rank, however the board is read.
 */

const PREFIX = 'lb';

const SEGMENTS: Readonly<Record<LeaderboardMetric, string>> = {
  net: 'net',
  hands: 'hands',
  winRate: 'winrate',
  bb100: 'bb100',
  biggestPot: 'pot',
  bestHand: 'besthand',
};

export function leaderboardKey(metric: LeaderboardMetric, periodKey: string): string {
  return `${PREFIX}:${SEGMENTS[metric]}:${periodKey}`;
}

/**
 * The key a rebuild builds into before swapping it over.
 *
 * A rebuild that deleted the live key and filled it back up would leave a
 * window — seconds, on a large set — where the board is empty or half there.
 * Building beside it and renaming is one atomic step, so a reader sees the old
 * board or the new one and never a partial one.
 */
export function stagingKey(metric: LeaderboardMetric, periodKey: string): string {
  return `${leaderboardKey(metric, periodKey)}:staging`;
}

/**
 * Metrics whose score is a running total, and so can be moved with `ZINCRBY`
 * without reading anything first.
 */
export const ADDITIVE_METRICS: readonly LeaderboardMetric[] = ['net', 'hands'];

/** Metrics whose score is a maximum: only ever raised, never summed. */
export const MAXIMUM_METRICS: readonly LeaderboardMetric[] = ['biggestPot', 'bestHand'];

/** Metrics recomputed from the row's totals, and gated on the hands threshold. */
export const RATE_INDEXED_METRICS: readonly LeaderboardMetric[] = ['winRate', 'bb100'];

export const ALL_METRICS: readonly LeaderboardMetric[] = [
  ...ADDITIVE_METRICS,
  ...MAXIMUM_METRICS,
  ...RATE_INDEXED_METRICS,
];
