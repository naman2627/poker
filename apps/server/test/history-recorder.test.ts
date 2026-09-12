/**
 * The queue between a hand of poker and a database.
 *
 * The promise it makes is narrow and absolute: recording is something a table
 * does *at* the history, never *with* it. No await, no error, no way for a slow
 * or dead database to reach the felt. These pin that down, and the shape of the
 * degradation when the database does go away.
 */
import { describe, expect, it, vi } from 'vitest';
import { HistoryRecorder } from '../src/history/recorder';
import type { HistoryRecord } from '../src/history/records';
import type { HistorySink, StoredHand } from '../src/history/sink';

interface Harness {
  recorder: HistoryRecorder;
  written: HistoryRecord[];
  /** Make the next `n` writes fail. */
  breakFor(n: number): void;
  /** Make writes hang, the way a database under load does. */
  hang(): void;
  /** Run every backoff that is waiting. */
  flushTimers(): Promise<void>;
}

function harness(options: { maxQueue?: number } = {}): Harness {
  const written: HistoryRecord[] = [];
  let failuresLeft = 0;
  let hanging = false;
  let pending: (() => void)[] = [];

  const sink: HistorySink = {
    write(record) {
      if (hanging) return new Promise<void>(() => undefined);
      if (failuresLeft > 0) {
        failuresLeft -= 1;
        return Promise.reject(new Error('the database is having a moment'));
      }
      written.push(record);
      return Promise.resolve();
    },
    recentHands: () => Promise.resolve<StoredHand[]>([]),
    hand: () => Promise.resolve(null),
    close: () => Promise.resolve(),
  };

  const recorder = new HistoryRecorder({
    sink,
    schedule: (callback) => {
      pending.push(callback);
    },
    ...(options.maxQueue === undefined ? {} : { maxQueue: options.maxQueue }),
  });

  return {
    recorder,
    written,
    breakFor(n) {
      failuresLeft = n;
    },
    hang() {
      hanging = true;
    },
    async flushTimers() {
      // Fire whatever backoff is waiting, let the promises settle, and go round
      // again. Awaiting `whenFlushed` here would deadlock: while writes are
      // failing the queue is never empty, so it never resolves.
      for (let round = 0; round < 30 && recorder.status.pending > 0; round += 1) {
        const due = pending;
        pending = [];
        for (const callback of due) callback();
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    },
  };
}

const tableOpened = (code = 'FELT42'): HistoryRecord => ({
  kind: 'table-opened',
  code,
  hostUserId: null,
  config: {},
  at: new Date('2026-09-10T12:00:00Z'),
});

const action = (seq: number): HistoryRecord => ({
  kind: 'hand-action',
  handId: '11111111-1111-4111-8111-111111111111',
  seq,
  userId: null,
  street: 'preflop',
  action: 'CHECK',
  amount: 0,
  potAfter: 0,
  elapsedMs: seq * 10,
});

describe('recording', () => {
  it('returns immediately even when the write never will', () => {
    const found = harness();
    // A database that has stopped answering — the worst case for a table, and
    // the one that must not reach it.
    found.hang();

    const before = Date.now();
    found.recorder.record(tableOpened());
    found.recorder.record(action(1));

    // Synchronous, and nothing to await: this is the whole contract.
    expect(Date.now() - before).toBeLessThan(50);
    expect(found.written).toHaveLength(0);
    expect(found.recorder.status.pending).toBeGreaterThan(0);
  });

  it('writes what it was given, in order', async () => {
    const { recorder, written } = harness();

    recorder.record(tableOpened());
    for (const seq of [1, 2, 3]) recorder.record(action(seq));
    await recorder.whenFlushed();

    expect(written.map((record) => record.kind)).toEqual([
      'table-opened',
      'hand-action',
      'hand-action',
      'hand-action',
    ]);
    expect(recorder.status.pending).toBe(0);
  });
});

describe('when the database is down', () => {
  it('does not throw at the caller', () => {
    const found = harness();
    found.breakFor(50);
    const { recorder } = found;

    // The table calls this from inside a hand. It has no catch, and needs none.
    expect(() => {
      recorder.record(tableOpened());
    }).not.toThrow();
  });

  it('says statistics are paused, and how far behind they are', async () => {
    const found = harness();
    found.breakFor(50);
    const { recorder } = found;

    recorder.record(tableOpened());
    recorder.record(action(1));
    await vi.waitFor(() => {
      expect(recorder.status.paused).toBe(true);
    });

    expect(recorder.status.pending).toBe(2);
    expect(recorder.status.lastError).toMatch(/having a moment/);
  });

  it('retries, and loses nothing when it comes back', async () => {
    const found = harness();
    found.breakFor(3);
    const { recorder, written, flushTimers } = found;

    recorder.record(tableOpened());
    recorder.record(action(1));
    recorder.record(action(2));
    await vi.waitFor(() => {
      expect(recorder.status.paused).toBe(true);
    });

    await flushTimers();

    expect(written).toHaveLength(3);
    expect(recorder.status.paused).toBe(false);
    expect(recorder.status.pending).toBe(0);
  });

  it('keeps the order across an outage rather than skipping the stuck record', async () => {
    // A hand cannot be written before the table it was dealt at. Skipping the
    // head to make progress would leave orphans and a record nobody could
    // trust, so a failure blocks the queue instead.
    const found = harness();
    found.breakFor(2);
    const { recorder, written, flushTimers } = found;

    recorder.record(tableOpened());
    recorder.record(action(1));
    await vi.waitFor(() => {
      expect(recorder.status.paused).toBe(true);
    });
    await flushTimers();

    expect(written.map((record) => record.kind)).toEqual(['table-opened', 'hand-action']);
  });

  it('drops the oldest rather than growing until the process dies', async () => {
    // Unbounded queueing would turn a database outage into an out-of-memory
    // kill, which would take the tables with it — the one outcome this whole
    // file exists to avoid.
    const found = harness({ maxQueue: 3 });
    found.breakFor(100);
    const { recorder, flushTimers, written } = found;

    for (const seq of [1, 2, 3, 4, 5]) recorder.record(action(seq));
    await vi.waitFor(() => {
      expect(recorder.status.paused).toBe(true);
    });

    expect(recorder.status.pending).toBeLessThanOrEqual(3);
    expect(recorder.status.dropped).toBe(2);

    found.breakFor(0);
    await flushTimers();
    expect(written).not.toHaveLength(0);
  });
});
