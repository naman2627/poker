import type { HistoryRecord } from './records';
import type { HistorySink, StoredHand } from './sink';

/**
 * The thing standing between a hand of poker and a database.
 *
 * `record()` puts a value on a queue and returns. It does not await a write, it
 * does not throw, and it has no failure a caller could handle — because the
 * caller is a table with four people waiting on it, and there is no answer to
 * "the statistics server is slow" that should involve them.
 *
 * When writes fail, they are retried with a backoff and the queue holds. The
 * table keeps dealing; the history falls behind and says so (`status.paused`),
 * which is what the history page shows instead of quietly presenting a short
 * list as a complete one.
 *
 * Order is preserved and matters: a hand cannot be written before the table it
 * was dealt at, and cards cannot be written before the hand they belong to. So a
 * failure blocks the queue rather than being skipped past — losing the head and
 * carrying on would leave orphans and a record nobody could trust.
 */
export interface RecorderOptions {
  readonly sink: HistorySink;
  readonly logger?: RecorderLogger;
  /** Injected so a test does not wait out a real backoff. */
  readonly schedule?: (callback: () => void, delayMs: number) => void;
  readonly retry?: RetryPolicy;
  /**
   * How many records may pile up before the oldest are dropped.
   *
   * Unbounded would trade a database outage for an out-of-memory kill, which
   * would take the tables with it — the one outcome this whole file exists to
   * avoid.
   */
  readonly maxQueue?: number;
}

export interface RetryPolicy {
  readonly initialMs: number;
  readonly maxMs: number;
  readonly factor: number;
}

export interface RecorderLogger {
  warn(details: Record<string, unknown>, message: string): void;
  error(details: Record<string, unknown>, message: string): void;
}

export const DEFAULT_RETRY: RetryPolicy = { initialMs: 500, maxMs: 30_000, factor: 2 };

export interface RecorderStatus {
  /** Records waiting to be written. */
  readonly pending: number;
  /**
   * True when writes are failing. The table is unaffected; the history is
   * behind by `pending` records.
   */
  readonly paused: boolean;
  readonly consecutiveFailures: number;
  /** Records thrown away because the queue was full. Never silently zero. */
  readonly dropped: number;
  readonly lastError: string | null;
}

export class HistoryRecorder {
  readonly #sink: HistorySink;
  readonly #logger: RecorderLogger;
  readonly #schedule: (callback: () => void, delayMs: number) => void;
  readonly #retry: RetryPolicy;
  readonly #maxQueue: number;

  #queue: HistoryRecord[] = [];
  #draining = false;
  #closed = false;
  #failures = 0;
  #dropped = 0;
  #lastError: string | null = null;
  /** Resolves when the queue is empty. Tests await it; nothing else does. */
  #idle: Promise<void> = Promise.resolve();
  #settleIdle: (() => void) | null = null;

  constructor(options: RecorderOptions) {
    this.#sink = options.sink;
    this.#logger = options.logger ?? silentLogger;
    this.#schedule =
      options.schedule ?? ((callback, delayMs) => void setTimeout(callback, delayMs));
    this.#retry = options.retry ?? DEFAULT_RETRY;
    this.#maxQueue = options.maxQueue ?? 10_000;
  }

  get status(): RecorderStatus {
    return {
      pending: this.#queue.length,
      paused: this.#failures > 0,
      consecutiveFailures: this.#failures,
      dropped: this.#dropped,
      lastError: this.#lastError,
    };
  }

  /**
   * Hand over a record and forget about it.
   *
   * Synchronous and total by construction: no promise to await, no error to
   * catch, nothing a caller has to decide.
   */
  record(record: HistoryRecord): void {
    if (this.#closed) return;

    if (this.#queue.length >= this.#maxQueue) {
      const dropped = this.#queue.shift();
      this.#dropped += 1;
      this.#logger.error(
        { dropped: this.#dropped, kind: dropped?.kind },
        'history queue is full — dropping the oldest record',
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

  /**
   * Resolves when everything queued has been written.
   *
   * `timeoutMs` matters more than it looks: shutdown waits on this, and a
   * database that is down would otherwise hold the process open for ever. A
   * timeout here means some statistics were lost, which is the right thing to
   * trade for a server that stops when it is told to.
   */
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
              'gave up flushing history — these records are lost',
            );
          }
          resolve();
        }, timeoutMs);
      }),
    ]);
  }

  recentHands(tableCode: string, limit: number): Promise<StoredHand[]> {
    return this.#sink.recentHands(tableCode, limit);
  }

  hand(handId: string): Promise<StoredHand | null> {
    return this.#sink.hand(handId);
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#queue = [];
    this.#settleIdle?.();
    this.#settleIdle = null;
    await this.#sink.close();
  }

  /**
   * One drain at a time, head first, never skipping.
   *
   * A record stays at the head until it is written. That is what keeps the
   * order intact across an outage: when the database comes back, the queue
   * replays from where it stopped rather than from wherever it had got to.
   */
  #drain(): void {
    if (this.#draining || this.#closed) return;
    this.#draining = true;

    void (async () => {
      while (this.#queue.length > 0 && !this.#closed) {
        const record = this.#queue[0];
        if (record === undefined) break;

        try {
          await this.#sink.write(record);
          this.#queue.shift();
          if (this.#failures > 0) {
            this.#logger.warn({ pending: this.#queue.length }, 'history writes are working again');
          }
          this.#failures = 0;
          this.#lastError = null;
        } catch (error: unknown) {
          this.#failures += 1;
          this.#lastError = error instanceof Error ? error.message : String(error);
          this.#logger.error(
            {
              kind: record.kind,
              attempt: this.#failures,
              pending: this.#queue.length,
              err: this.#lastError,
            },
            'history write failed — statistics are paused, the table is not',
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

const silentLogger: RecorderLogger = {
  warn: () => undefined,
  error: () => undefined,
};
