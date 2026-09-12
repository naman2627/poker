import { MIN_RANKED_HANDS, handCategoryRank, type LeaderboardMetric } from '@poker/shared';
import type { StatCounters } from './delta';
import { ALL_METRICS } from './keys';
import type { LeaderboardIndex, StatsStore } from './ports';

/**
 * Rebuild every sorted set from Postgres.
 *
 * This job is the reason the mirror is allowed to be best-effort, and the reason
 * a Redis eviction policy is a capacity decision rather than a data-loss one.
 * Everything in Redis is derived; this is the derivation, run from the source of
 * truth, and after it has run the two agree exactly.
 *
 * It runs on boot — so a server that comes up against an empty Redis serves a
 * correct board immediately rather than a board that fills in as people play —
 * and hourly after that, which bounds how long any drift can last.
 *
 * Each board is built into a staging key and renamed over the live one, so a
 * rebuild is invisible to anybody reading: they get the old board or the new
 * board, never a half-filled one. See `replace` in the index implementations.
 *
 * The threshold is applied here too, and in the same way: a player under
 * `MIN_RANKED_HANDS` is left out of the two rate boards entirely rather than
 * added with a score that a reader would then have to know to ignore.
 */
export interface RebuildOptions {
  readonly store: StatsStore;
  readonly index: LeaderboardIndex;
  readonly logger?: RebuildLogger;
}

export interface RebuildLogger {
  info(details: Record<string, unknown>, message: string): void;
  error(details: Record<string, unknown>, message: string): void;
}

export interface RebuildResult {
  readonly periods: number;
  readonly boards: number;
  readonly members: number;
  readonly durationMs: number;
}

export async function rebuildLeaderboards(options: RebuildOptions): Promise<RebuildResult> {
  const startedAt = Date.now();
  const periodKeys = await options.store.periodKeys();

  let boards = 0;
  let members = 0;

  for (const periodKey of periodKeys) {
    const rows = await options.store.snapshot(periodKey);

    for (const metric of ALL_METRICS) {
      const entries = rows
        .filter((row) => qualifies(metric, row.counters))
        .map((row) => ({ userId: row.userId, score: scoreOf(metric, row.counters) }));

      await options.index.replace(metric, periodKey, entries);
      boards += 1;
      members += entries.length;
    }
  }

  const result: RebuildResult = {
    periods: periodKeys.length,
    boards,
    members,
    durationMs: Date.now() - startedAt,
  };

  options.logger?.info({ ...result }, 'leaderboards rebuilt from player_stats');
  return result;
}

/** How often the boards are regenerated from the source of truth. */
export const REBUILD_INTERVAL_MS = 60 * 60 * 1000;

export interface RebuildScheduleOptions extends RebuildOptions {
  readonly intervalMs?: number;
  /** Injected so a test does not wait out an hour. */
  readonly schedule?: (callback: () => void, delayMs: number) => { cancel(): void };
}

/**
 * Run it now, and every hour.
 *
 * The boot run is deliberately not awaited by the caller's startup path: a
 * server whose Redis is slow should still start listening, because a stale
 * board is a much smaller problem than a server that will not come up. A
 * failure is logged and the next hour tries again.
 *
 * Returns a stop function; shutdown calls it so a pending timer cannot hold the
 * process open.
 */
export function startLeaderboardRebuilds(options: RebuildScheduleOptions): () => void {
  const intervalMs = options.intervalMs ?? REBUILD_INTERVAL_MS;
  const schedule =
    options.schedule ??
    ((callback, delayMs) => {
      const timer = setInterval(callback, delayMs);
      timer.unref?.();
      return {
        cancel: () => {
          clearInterval(timer);
        },
      };
    });

  let running = false;
  let stopped = false;

  const run = (): void => {
    // One at a time. An hourly job that has not finished in an hour should not
    // be started again alongside itself.
    if (running || stopped) return;
    running = true;

    void rebuildLeaderboards(options)
      .catch((error: unknown) => {
        options.logger?.error(
          { err: error instanceof Error ? error.message : String(error) },
          'leaderboard rebuild failed — the boards are stale until the next run',
        );
      })
      .finally(() => {
        running = false;
      });
  };

  run();
  const timer = schedule(run, intervalMs);

  return () => {
    stopped = true;
    timer.cancel();
  };
}

/**
 * The score a metric carries in its sorted set.
 *
 * The third copy of this arithmetic, next to the Postgres `order by` and the
 * in-memory store's comparator, and deliberately so: a rebuild that computed a
 * score differently from the live mirror would produce a board that changed
 * every hour and settled back in between. The three are checked against each
 * other in `test/stats-rebuild.test.ts`.
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
  // A player with no hands has nothing to rank; leaving them out keeps an empty
  // account off the bottom of every board.
  return counters.handsPlayed > 0;
}
