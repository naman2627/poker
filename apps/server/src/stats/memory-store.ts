import {
  MIN_RANKED_HANDS,
  handCategoryRank,
  type LeaderboardMetric,
  type PlayerHand,
} from '@poker/shared';
import { applyDelta, emptyCounters, type PlayerHandDelta, type StatCounters } from './delta';
import { ALLTIME_KEY } from './periods';
import type {
  AppliedEntry,
  AppliedHand,
  StatsProfile,
  StatsSnapshotRow,
  StatsStore,
} from './ports';

/**
 * The counters, in Maps.
 *
 * The same reason `history/memory-sink.ts` and `auth/memory-adapters.ts` exist:
 * the whole product has to come up with `pnpm dev` on a laptop with nothing
 * installed, and the end-to-end run has to be able to play twenty hands and see
 * a leaderboard at the end of them without a container.
 *
 * It loses everything when the process does, and it is held to the same rules
 * the real one is: the same threshold, the same tie-breaking, the same
 * definition of a streak. `applyDelta` in `delta.ts` is shared with nothing else
 * precisely so that "what does one hand do to a row" has one answer here and in
 * Postgres.
 *
 * Names come off the records rather than a join, because there is nothing here
 * to join to — again, exactly as the memory history sink does it.
 */
export interface MemoryStatsStoreOptions {
  /**
   * Who somebody is, and what they have played.
   *
   * Asked of the memory history sink rather than kept here, because that sink
   * already holds both and a second copy would be a second thing to keep in
   * step. In the Postgres build these two are joins; see `memory-sink.ts`.
   */
  readonly profileFor?: (
    userId: string,
  ) => { displayName: string; avatarSeed: string | null } | null;
  readonly handsFor?: (userId: string, limit: number) => PlayerHand[];
}

export function createMemoryStatsStore(options: MemoryStatsStoreOptions = {}): StatsStore {
  /** `userId` -> `periodKey` -> counters. */
  const rows = new Map<string, Map<string, StatCounters>>();
  const profileFor = options.profileFor ?? (() => null);
  const handsFor = options.handsFor ?? (() => []);

  const rowFor = (userId: string, periodKey: string, at: Date): StatCounters => {
    const byPeriod = rows.get(userId) ?? new Map<string, StatCounters>();
    rows.set(userId, byPeriod);
    return byPeriod.get(periodKey) ?? emptyCounters(at);
  };

  const all = (periodKey: string): StatsSnapshotRow[] => {
    const found: StatsSnapshotRow[] = [];
    for (const [userId, byPeriod] of rows) {
      const counters = byPeriod.get(periodKey);
      if (counters) found.push({ userId, counters });
    }
    return found;
  };

  const ordered = (metric: LeaderboardMetric, periodKey: string): StatsSnapshotRow[] =>
    all(periodKey)
      .filter((row) => qualifies(metric, row.counters))
      .sort((a, b) => scoreOf(metric, b.counters) - scoreOf(metric, a.counters));

  return {
    applyHand(deltas: readonly PlayerHandDelta[]): Promise<AppliedHand> {
      const entries: AppliedEntry[] = [];

      for (const delta of deltas) {
        for (const periodKey of delta.periodKeys) {
          const next = applyDelta(rowFor(delta.userId, periodKey, delta.at), delta);
          rows.get(delta.userId)?.set(periodKey, next);
          entries.push({ userId: delta.userId, periodKey, delta, counters: next });
        }
      }

      return Promise.resolve({ entries });
    },

    snapshot(periodKey: string): Promise<StatsSnapshotRow[]> {
      return Promise.resolve(all(periodKey));
    },

    periodKeys(): Promise<string[]> {
      const keys = new Set<string>([ALLTIME_KEY]);
      for (const byPeriod of rows.values()) for (const key of byPeriod.keys()) keys.add(key);
      return Promise.resolve([...keys]);
    },

    counters(userId: string, periodKey: string): Promise<StatCounters | null> {
      return Promise.resolve(rows.get(userId)?.get(periodKey) ?? null);
    },

    countersMany(
      userIds: readonly string[],
      periodKey: string,
    ): Promise<Map<string, StatCounters>> {
      const found = new Map<string, StatCounters>();
      for (const userId of userIds) {
        const counters = rows.get(userId)?.get(periodKey);
        if (counters) found.set(userId, counters);
      }
      return Promise.resolve(found);
    },

    profiles(userIds: readonly string[]): Promise<Map<string, StatsProfile>> {
      const found = new Map<string, StatsProfile>();
      for (const userId of userIds) {
        const profile = profileFor(userId);
        if (profile) found.set(userId, { userId, ...profile });
      }
      return Promise.resolve(found);
    },

    top(metric: LeaderboardMetric, periodKey: string, limit: number): Promise<StatsSnapshotRow[]> {
      return Promise.resolve(ordered(metric, periodKey).slice(0, limit));
    },

    rank(userId: string, metric: LeaderboardMetric, periodKey: string): Promise<number | null> {
      const mine = rows.get(userId)?.get(periodKey) ?? null;
      if (mine === null || !qualifies(metric, mine)) return Promise.resolve(null);

      const value = scoreOf(metric, mine);
      const ahead = ordered(metric, periodKey).filter(
        (row) => scoreOf(metric, row.counters) > value,
      ).length;

      return Promise.resolve(ahead + 1);
    },

    recentHands(userId: string, limit: number): Promise<PlayerHand[]> {
      return Promise.resolve(handsFor(userId, limit));
    },

    close: () => Promise.resolve(),
  };
}

/**
 * The same score the Postgres store orders by, and the same threshold.
 *
 * Duplicated deliberately rather than shared through a query builder: these are
 * six one-line expressions, and the pair of them being visibly the same
 * arithmetic is worth more than an abstraction that hides which one ran.
 */
function scoreOf(metric: LeaderboardMetric, counters: StatCounters): number {
  switch (metric) {
    case 'net':
      return counters.netChips;
    case 'hands':
      return counters.handsPlayed;
    case 'biggestPot':
      return counters.biggestPot;
    case 'winRate':
      return counters.handsPlayed === 0 ? 0 : (counters.handsWon / counters.handsPlayed) * 100;
    case 'bb100':
      return counters.bigBlindSum === 0 ? 0 : (counters.netChips / counters.bigBlindSum) * 100;
    case 'bestHand':
      return handCategoryRank(counters.bestHandCategory);
  }
}

function qualifies(metric: LeaderboardMetric, counters: StatCounters): boolean {
  if (metric === 'winRate' || metric === 'bb100') return counters.handsPlayed >= MIN_RANKED_HANDS;
  if (metric === 'bestHand') return counters.bestHandCategory !== null;
  return true;
}
