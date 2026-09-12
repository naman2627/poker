import type { HandEnded } from '../history/records';
import { deltasFor } from './delta';
import type { LeaderboardIndex, StatsStore } from './ports';

/**
 * The thing standing between a finished hand and the counters.
 *
 * The same bargain `HistoryRecorder` makes, for the same reason: `record()` puts
 * a hand on a queue and returns. It does not await a write, it does not throw,
 * and there is no failure a caller could do anything about — because the caller
 * is a table with four people waiting on it.
 *
 * It is a separate queue from the history recorder's, deliberately. The two
 * writes have different retry semantics and mixing them would break one of
 * them:
 *
 *   - a history `hand-ended` is an UPDATE, so retrying it writes the same row
 *     again and nothing is harmed
 *   - a stats `applyHand` is an INCREMENT, so retrying one that had already
 *     committed would count the hand twice
 *
 * Retrying is therefore only ever safe here when the transaction *failed*, and
 * a failed transaction rolled back — which is precisely what `applyHand`
 * guarantees by doing all of its work in one. So a throw from the store means
 * nothing was written and the hand is safe to try again; anything after the
 * commit is not retried at all.
 *
 * The mirror is the "anything after the commit". It is best effort by design:
 * Redis is derived data, a missed mirror is a stale board, and
 * `rebuildLeaderboards()` puts it right within the hour. It is logged and never
 * retried, because retrying a `ZINCRBY` that may already have landed is how a
 * board starts drifting away from the table it is supposed to describe.
 */
export interface StatsRecorderOptions {
  readonly store: StatsStore;
  readonly index: LeaderboardIndex;
  readonly logger?: StatsLogger;
  /** Injected so a test does not wait out a real backoff. */
  readonly schedule?: (callback: () => void, delayMs: number) => void;
  readonly retry?: { initialMs: number; maxMs: number; factor: number };
  /**
   * How many hands may pile up before the oldest are dropped. Unbounded would
   * trade a database outage for an out-of-memory kill, which would take the
   * tables with it.
   */
  readonly maxQueue?: number;
}

export interface StatsLogger {
  warn(details: Record<string, unknown>, message: string): void;
  error(details: Record<string, unknown>, message: string): void;
}

export interface StatsRecorderStatus {
  readonly pending: number;
  /** True when writes are failing. The table is unaffected. */
  readonly paused: boolean;
  readonly consecutiveFailures: number;
  readonly dropped: number;
  readonly lastError: string | null;
}

const DEFAULT_RETRY = { initialMs: 500, maxMs: 30_000, factor: 2 };

export class StatsRecorder {
  readonly #store: StatsStore;
  readonly #index: LeaderboardIndex;
  readonly #logger: StatsLogger;
  readonly #schedule: (callback: () => void, delayMs: number) => void;
  readonly #retry: { initialMs: number; maxMs: number; factor: number };
  readonly #maxQueue: number;

  #queue: HandEnded[] = [];
  #draining = false;
  #closed = false;
  #failures = 0;
  #dropped = 0;
  #lastError: string | null = null;
  #idle: Promise<void> = Promise.resolve();
  #settleIdle: (() => void) | null = null;

  constructor(options: StatsRecorderOptions) {
    this.#store = options.store;
    this.#index = options.index;
    this.#logger = options.logger ?? silentLogger;
    this.#schedule =
      options.schedule ?? ((callback, delayMs) => void setTimeout(callback, delayMs));
    this.#retry = options.retry ?? DEFAULT_RETRY;
    this.#maxQueue = options.maxQueue ?? 10_000;
  }

  get status(): StatsRecorderStatus {
    return {
      pending: this.#queue.length,
      paused: this.#failures > 0,
      consecutiveFailures: this.#failures,
      dropped: this.#dropped,
      lastError: this.#lastError,
    };
  }

  /** Hand over a finished hand and forget about it. Synchronous and total. */
  record(record: HandEnded): void {
    if (this.#closed) return;

    if (this.#queue.length >= this.#maxQueue) {
      this.#queue.shift();
      this.#dropped += 1;
      this.#logger.error(
        { dropped: this.#dropped },
        'statistics queue is full — dropping the oldest hand',
      );
    }

    this.#queue.push(record);
    if (this.#settleIdle === null) {
      this.#idle = new Promise<void>((resolve) => {
        this.#settleIdle = resolve;
      });
    }
    this.#drain();
  }

  /** Resolves when everything queued has been counted. Tests await it. */
  whenFlushed(timeoutMs?: number): Promise<void> {
    if (this.#queue.length === 0) return Promise.resolve();
    if (timeoutMs === undefined) return this.#idle;

    return Promise.race([
      this.#idle,
      new Promise<void>((resolve) => {
        this.#schedule(() => {
          if (this.#queue.length > 0) {
            this.#logger.error(
              { pending: this.#queue.length },
              'gave up flushing statistics — these hands are not counted',
            );
          }
          resolve();
        }, timeoutMs);
      }),
    ]);
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#queue = [];
    this.#settleIdle?.();
    this.#settleIdle = null;
    await this.#index.close();
    await this.#store.close();
  }

  /**
   * One at a time, head first, never skipping.
   *
   * A hand stays at the head until its transaction commits. Skipping past a
   * failure would silently lose a hand from every board it belonged on, and
   * nothing downstream would ever notice the gap.
   */
  #drain(): void {
    if (this.#draining || this.#closed) return;
    this.#draining = true;

    void (async () => {
      while (this.#queue.length > 0 && !this.#closed) {
        const record = this.#queue[0];
        if (record === undefined) break;

        try {
          // The truth first, and on its own. If this throws, the transaction
          // rolled back and the hand can safely be tried again.
          const applied = await this.#store.applyHand(deltasFor(record));
          this.#queue.shift();

          if (this.#failures > 0) {
            this.#logger.warn(
              { pending: this.#queue.length },
              'statistics writes are working again',
            );
          }
          this.#failures = 0;
          this.#lastError = null;

          // Then the mirror, which is derived and disposable. Never retried:
          // the hourly rebuild is what puts a missed one right.
          await this.#index.mirror(applied).catch((error: unknown) => {
            this.#logger.warn(
              {
                handId: record.handId,
                err: error instanceof Error ? error.message : String(error),
              },
              'could not mirror a hand into the leaderboards — the next rebuild will',
            );
          });
        } catch (error: unknown) {
          this.#failures += 1;
          this.#lastError = error instanceof Error ? error.message : String(error);
          this.#logger.error(
            {
              handId: record.handId,
              attempt: this.#failures,
              pending: this.#queue.length,
              err: this.#lastError,
            },
            'statistics write failed — the boards are paused, the table is not',
          );

          this.#draining = false;
          this.#schedule(() => {
            this.#drain();
          }, this.#backoffMs());
          return;
        }
      }

      this.#draining = false;
      this.#settleIdle?.();
      this.#settleIdle = null;
    })();
  }

  #backoffMs(): number {
    const raw = this.#retry.initialMs * Math.pow(this.#retry.factor, this.#failures - 1);
    return Math.min(this.#retry.maxMs, Math.round(raw));
  }
}

const silentLogger: StatsLogger = {
  warn: () => undefined,
  error: () => undefined,
};
