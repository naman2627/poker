import {
  EMPTY_STAT_CARD,
  LEADERBOARD_PAGE_SIZE,
  PLAYER_RECENT_HANDS,
  handsToQualify,
  metricValue,
  qualifiesFor,
  type LeaderboardEntry,
  type LeaderboardMetric,
  type LeaderboardPeriod,
  type LeaderboardResponse,
  type PlayerProfileResponse,
  type PlayerStatCard,
} from '@poker/shared';
import { emptyCounters } from './delta';
import { ALL_METRICS } from './keys';
import { periodKeyFor } from './periods';
import { toStatCard, type LeaderboardIndex, type StatsStore } from './ports';

/**
 * Reading a board.
 *
 * Two rules run through this file, and both are in CLAUDE.md's spirit rather
 * than its letter:
 *
 *   1. A leaderboard is never computed by scanning the record of play. The
 *      counters were written when the hand ended; reading them is a `ZREVRANGE`
 *      against a sorted set, or an index scan of one small table when the
 *      sorted set cannot be reached. `hand_actions` is a replay log and is
 *      never aggregated on a request.
 *
 *   2. The top fifty is cached for thirty seconds. A board is a slow-moving
 *      thing — a hand takes a minute or two to play — so thirty seconds of
 *      staleness costs a reader nothing and saves fifty-odd round trips from
 *      every person watching it.
 *
 * The viewer's own row is deliberately *not* cached with the board: it is
 * per-person, it is one extra lookup, and caching it would mean either a cache
 * entry per viewer or a board that showed somebody else their neighbour's rank.
 */
export interface StatsServiceOptions {
  readonly store: StatsStore;
  readonly index: LeaderboardIndex;
  /** Injected so a test does not have to wait thirty seconds to see it expire. */
  readonly now?: () => number;
  readonly cacheMs?: number;
}

/** How long a top-fifty answer is reused. */
export const LEADERBOARD_CACHE_MS = 30_000;

export interface StatsService {
  leaderboard(
    metric: LeaderboardMetric,
    period: LeaderboardPeriod,
    viewerUserId: string | null,
  ): Promise<LeaderboardResponse>;

  player(userId: string): Promise<PlayerProfileResponse | null>;
}

interface CachedBoard {
  readonly at: number;
  readonly entries: readonly LeaderboardEntry[];
  readonly periodKey: string;
  readonly degraded: boolean;
}

export function createStatsService(options: StatsServiceOptions): StatsService {
  const now = options.now ?? Date.now;
  const cacheMs = options.cacheMs ?? LEADERBOARD_CACHE_MS;
  const cache = new Map<string, CachedBoard>();

  /**
   * The top fifty, from the index if it answers and from Postgres if it does
   * not.
   *
   * The fallback is not a degraded *answer* — it is the same numbers from the
   * table they were mirrored from — but it is a degraded *path*, so the
   * response says so. The history page already tells a reader when statistics
   * are behind; this is the same honesty applied to the boards.
   */
  const board = async (metric: LeaderboardMetric, periodKey: string): Promise<CachedBoard> => {
    const cacheKey = `${metric}:${periodKey}`;
    const cached = cache.get(cacheKey);
    if (cached && now() - cached.at < cacheMs) return cached;

    const { rows, degraded } = await topRows(metric, periodKey);

    const userIds = rows.map((row) => row.userId);
    const [profiles, cards] = await Promise.all([
      options.store.profiles(userIds),
      cardsFor(userIds, periodKey),
    ]);

    const entries = rows.map((row, position) => {
      const stats = cards.get(row.userId) ?? EMPTY_STAT_CARD;
      return entryFor(metric, row.userId, profiles, stats, position + 1);
    });

    const built: CachedBoard = { at: now(), entries, periodKey, degraded };
    cache.set(cacheKey, built);
    return built;
  };

  /**
   * The ordered user ids, from the index if it can answer and the record if it
   * cannot.
   *
   * An empty sorted set is ambiguous — nobody has played this week, or the key
   * was evicted — so Postgres settles it either way. That costs one cheap query
   * on a board that was probably going to be empty anyway, and it is what stops
   * an eviction showing as "nobody is on this leaderboard".
   *
   * `degraded` is about the *path*, not the answer: it is true when the index
   * could not be read at all, and when the index came back empty but the record
   * did not, which means the mirror is behind and the next rebuild has work to
   * do. A board that is empty in both is simply empty, and says so.
   */
  const topRows = async (
    metric: LeaderboardMetric,
    periodKey: string,
  ): Promise<{ rows: { userId: string }[]; degraded: boolean }> => {
    let reachable = true;
    let rows: { userId: string }[] = [];

    try {
      rows = await options.index.top(metric, periodKey, LEADERBOARD_PAGE_SIZE);
    } catch {
      reachable = false;
    }

    if (reachable && rows.length > 0) return { rows, degraded: false };

    const fromStore = await options.store.top(metric, periodKey, LEADERBOARD_PAGE_SIZE);
    return { rows: fromStore, degraded: !reachable || fromStore.length > 0 };
  };

  /** Fifty stat cards in one query, so the other columns cost one round trip. */
  const cardsFor = async (
    userIds: readonly string[],
    periodKey: string,
  ): Promise<Map<string, PlayerStatCard>> => {
    const counters = await options.store.countersMany(userIds, periodKey);
    const cards = new Map<string, PlayerStatCard>();
    for (const userId of userIds) {
      cards.set(userId, toStatCard(counters.get(userId) ?? emptyCounters(new Date(now()))));
    }
    return cards;
  };

  const rankOf = async (
    userId: string,
    metric: LeaderboardMetric,
    periodKey: string,
    handsPlayed: number,
  ): Promise<number | null> => {
    if (!qualifiesFor(metric, handsPlayed)) return null;

    try {
      const fromIndex = await options.index.rank(userId, metric, periodKey);
      if (fromIndex !== null) return fromIndex;
    } catch {
      // Fall through to the source of truth.
    }
    return options.store.rank(userId, metric, periodKey);
  };

  /**
   * The viewer's own line.
   *
   * Taken from the board when they are already on it, so the pinned row and the
   * row further down agree to the chip. Otherwise looked up on its own — which
   * is the case that matters, because the whole point of pinning it is for the
   * person who is nowhere near the top fifty.
   */
  const viewerRow = async (
    userId: string,
    metric: LeaderboardMetric,
    periodKey: string,
    entries: readonly LeaderboardEntry[],
  ): Promise<LeaderboardEntry | null> => {
    const onBoard = entries.find((entry) => entry.userId === userId);
    if (onBoard) return onBoard;

    const counters = await options.store.counters(userId, periodKey);
    if (counters === null) return null;

    const stats = toStatCard(counters);
    const profiles = await options.store.profiles([userId]);
    const rank = await rankOf(userId, metric, periodKey, stats.handsPlayed);

    return entryFor(metric, userId, profiles, stats, rank);
  };

  return {
    async leaderboard(
      metric: LeaderboardMetric,
      period: LeaderboardPeriod,
      viewerUserId: string | null,
    ): Promise<LeaderboardResponse> {
      const periodKey = periodKeyFor(period, new Date(now()));
      const built = await board(metric, periodKey);

      return {
        metric,
        period,
        periodKey,
        entries: [...built.entries],
        viewer:
          viewerUserId === null
            ? null
            : await viewerRow(viewerUserId, metric, periodKey, built.entries),
        computedAt: new Date(now()).toISOString(),
        degraded: built.degraded,
      };
    },

    async player(userId: string): Promise<PlayerProfileResponse | null> {
      const [profiles, counters, recentHands] = await Promise.all([
        options.store.profiles([userId]),
        options.store.counters(userId, 'alltime'),
        options.store.recentHands(userId, PLAYER_RECENT_HANDS),
      ]);

      const profile = profiles.get(userId);
      // No account, and no hand ever counted: there is nobody to show. A real
      // account that has simply never played does have a profile, and gets an
      // empty card rather than a 404.
      if (!profile && counters === null) return null;

      const stats = toStatCard(counters ?? emptyCounters(new Date(now())));

      // Every metric, so the record the schema expects is complete rather than
      // partial — a missing key here would be a validation failure at the edge.
      const ranks = {} as Record<LeaderboardMetric, number | null>;
      for (const metric of ALL_METRICS) {
        ranks[metric] = await rankOf(userId, metric, 'alltime', stats.handsPlayed);
      }

      return {
        userId,
        displayName: profile?.displayName ?? '',
        avatarSeed: profile?.avatarSeed ?? null,
        stats,
        ranks,
        recentHands,
      };
    },
  };
}

/**
 * One row of a board.
 *
 * `rank` is null exactly when the player does not qualify, and `handsToQualify`
 * is what is shown in its place — "37 more hands to qualify" rather than a
 * position that would mean nothing. `value` is the metric already computed, by
 * the same function the client formats with, so the column a player is ranked
 * on and the column they are shown cannot drift apart.
 */
function entryFor(
  metric: LeaderboardMetric,
  userId: string,
  profiles: ReadonlyMap<string, { displayName: string; avatarSeed: string | null }>,
  stats: PlayerStatCard,
  rank: number | null,
): LeaderboardEntry {
  const profile = profiles.get(userId);
  const qualified = qualifiesFor(metric, stats.handsPlayed);

  return {
    rank: qualified ? rank : null,
    userId,
    displayName: profile?.displayName ?? '',
    avatarSeed: profile?.avatarSeed ?? null,
    value: metricValue(metric, stats),
    qualified,
    handsToQualify: handsToQualify(stats.handsPlayed),
    stats,
  };
}
