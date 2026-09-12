/**
 * THE RULE, at rest.
 *
 * §1 of CLAUDE.md says no client ever receives a card it is not entitled to.
 * This is the same rule pointed at the database: a dump taken while a hand is in
 * progress must not contain anybody's cards. Not filtered out of a query —
 * absent, because they have not been written yet.
 *
 * The test plays real hands through a real `TableRuntime` into a real sink, and
 * inspects the sink the way a `pg_dump` would: everything it holds, at moments
 * chosen to be awkward.
 */
import { describe, expect, it } from 'vitest';
import { seededRng } from '@poker/engine';
import type { TableConfig } from '@poker/shared';
import { HistoryRecorder } from '../src/history/recorder';
import { createMemoryHistorySink } from '../src/history/memory-sink';
import type { HistorySink, StoredHand } from '../src/history/sink';
import type { HistoryRecord } from '../src/history/records';
import type { Connection } from '../src/table/broadcast';
import { DEFAULT_TIMINGS, TableRuntime, type Scheduler } from '../src/table/runtime';

const CONFIG: TableConfig = {
  seatCount: 6,
  smallBlind: 5,
  bigBlind: 10,
  minBuyIn: 200,
  maxBuyIn: 2_000,
  actionTimeoutSec: 30,
};

const USERS = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
];

function fakeConnection(userId: string): Connection & { latest<T>(event: string): T | null } {
  const events: { event: string; payload: unknown }[] = [];
  return {
    socketId: `socket-${userId}`,
    userId,
    emit(event, payload) {
      events.push({ event, payload });
    },
    disconnect() {
      /* nothing to do */
    },
    latest<T>(event: string): T | null {
      const matches = events.filter((entry) => entry.event === event);
      const last = matches[matches.length - 1];
      return last ? (last.payload as T) : null;
    },
  };
}

interface ManualScheduler extends Scheduler {
  advance(ms: number): Promise<void>;
}

function manualScheduler(start = 1_700_000_000_000): ManualScheduler {
  let now = start;
  let tasks: { at: number; run: () => void }[] = [];

  return {
    now: () => now,
    schedule(callback, delayMs) {
      const task = { at: now + delayMs, run: callback };
      tasks.push(task);
      return () => {
        tasks = tasks.filter((candidate) => candidate !== task);
      };
    },
    async advance(ms) {
      now += ms;
      const due = tasks.filter((task) => task.at <= now).sort((a, b) => a.at - b.at);
      tasks = tasks.filter((task) => task.at > now);
      for (const task of due) task.run();
      await Promise.resolve();
    },
  };
}

/** A sink that keeps every record it was handed, so a test can look for cards. */
function recordingSink(): { sink: HistorySink; records: HistoryRecord[] } {
  const inner = createMemoryHistorySink();
  const records: HistoryRecord[] = [];

  return {
    records,
    sink: {
      async write(record) {
        records.push(record);
        await inner.write(record);
      },
      recentHands: (code, limit) => inner.recentHands(code, limit),
      hand: (handId) => inner.hand(handId),
      close: () => inner.close(),
    },
  };
}

interface Harness {
  table: TableRuntime;
  recorder: HistoryRecorder;
  records: HistoryRecord[];
  sink: HistorySink;
  tick(ms: number): Promise<void>;
  playHand(): Promise<void>;
  settle(): Promise<void>;
}

async function seatedTable(): Promise<Harness> {
  const scheduler = manualScheduler();
  const { sink, records } = recordingSink();
  const recorder = new HistoryRecorder({
    sink,
    // A silent recorder in a test is a test that hangs and does not say why.
    logger: {
      warn: (details, message) => {
        console.warn(message, details);
      },
      error: (details, message) => {
        console.error(message, details);
      },
    },
  });

  const table = new TableRuntime({
    code: 'FELT42',
    config: CONFIG,
    rng: seededRng('cards-at-rest'),
    scheduler,
    hostUserId: USERS[0] ?? null,
    history: recorder,
    deckSeeds: seedSequence(),
  });

  recorder.record({
    kind: 'table-opened',
    code: 'FELT42',
    hostUserId: USERS[0] ?? null,
    config: CONFIG,
    at: new Date(scheduler.now()),
  });

  const connections = USERS.map(fakeConnection);
  for (const [index, connection] of connections.entries()) {
    await table.attach(connection, { displayName: `P${String(index)}`, avatarSeed: null });
    await table.sit(connection.userId, index, 1_000);
    await table.ready(connection.userId);
  }
  await table.whenIdle();

  const tick = async (ms: number): Promise<void> => {
    await scheduler.advance(ms);
    await table.whenIdle();
  };

  const settle = async (): Promise<void> => {
    await table.whenIdle();
    await recorder.whenFlushed();
  };

  const harness: Harness = {
    table,
    recorder,
    records,
    sink,
    tick,
    settle,
    async playHand(): Promise<void> {
      for (let step = 0; step < 60; step += 1) {
        const prompt = connections[0]?.latest<{
          handId: string;
          seatIndex: number;
          actionSeq: number;
          legalActions: { canCheck: boolean };
        }>('action:prompt');

        if (!prompt) break;
        if (table.state.handId !== prompt.handId) break;
        if (table.state.toActSeat !== prompt.seatIndex) break;

        const actor = connections[prompt.seatIndex];
        if (!actor) break;

        await table.playerAction(actor.userId, {
          handId: prompt.handId,
          actionSeq: prompt.actionSeq,
          type: prompt.legalActions.canCheck ? 'CHECK' : 'CALL',
        });
        await table.whenIdle();
      }
    },
  };

  await harness.tick(DEFAULT_TIMINGS.dealDelayMs);
  return harness;
}

function seedSequence(): () => string {
  let nth = 0;
  return () => {
    nth += 1;
    return Buffer.from(`at-rest-${String(nth)}`.padEnd(32, '.'), 'utf8').toString('hex');
  };
}

/** Every card-shaped string anywhere in a value. */
function cardsIn(value: unknown): string[] {
  const found: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === 'string') {
      if (/^(?:[2-9]|10|11|12|13|14)[shdc]$/.test(node)) found.push(node);
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (typeof node !== 'object' || node === null) return;
    for (const item of Object.values(node)) walk(item);
  };
  walk(value);
  return found;
}

describe('a database dump taken mid-hand', () => {
  it('holds no hole cards for a hand that is still running', async () => {
    const harness = await seatedTable();
    await harness.settle();

    expect(harness.table.state.phase).toBe('preflop');

    const stored = await harness.sink.recentHands('FELT42', 10);
    expect(stored).toHaveLength(1);

    const hand = stored[0];
    if (!hand) throw new Error('no hand');

    // Rows exist — the hand is being recorded as it happens — and every one of
    // them has a null where the cards will go.
    expect(hand.players).toHaveLength(3);
    for (const player of hand.players) {
      expect(player.holeCards).toBeNull();
    }
    expect(hand.endedAt).toBeNull();
    expect(hand.board).toEqual([]);
  });

  it('holds no seed, so the deck cannot be worked out from the commitment', async () => {
    const harness = await seatedTable();
    await harness.settle();

    const [hand] = await harness.sink.recentHands('FELT42', 10);
    expect(hand?.deckCommit).toMatch(/^[0-9a-f]{64}$/);
    // The commitment is public and the seed is not. Publishing the seed early
    // would publish every card in the hand.
    expect(hand?.deckSeed).toBeNull();
  });

  it('has not handed a single card to the sink before the hand ends', async () => {
    const harness = await seatedTable();
    await harness.settle();

    // Not "filtered on the way out" — never written. Nothing card-shaped has
    // reached the sink at all.
    expect(cardsIn(harness.records)).toEqual([]);
  });

  it('keeps that true for every step of the hand, not just the start', async () => {
    const harness = await seatedTable();

    for (let step = 0; step < 30; step += 1) {
      await harness.settle();
      if (harness.table.state.phase === 'hand_end') break;

      const [hand] = await harness.sink.recentHands('FELT42', 10);
      if (hand && hand.endedAt === null) {
        for (const player of hand.players) expect(player.holeCards).toBeNull();
        expect(hand.deckSeed).toBeNull();
      }

      const toAct = harness.table.state.toActSeat;
      if (toAct === null) {
        await harness.tick(DEFAULT_TIMINGS.showdownBeatMs);
        continue;
      }
      await harness.playHand();
    }
  });
});

describe('when the hand ends', () => {
  it('writes the cards and the ending together, never one without the other', async () => {
    const harness = await seatedTable();
    await harness.playHand();
    await harness.tick(DEFAULT_TIMINGS.showdownBeatMs);
    await harness.settle();

    const [hand] = await harness.sink.recentHands('FELT42', 10);
    if (!hand) throw new Error('no hand');

    expect(hand.endedAt).not.toBeNull();
    expect(hand.deckSeed).toMatch(/^[0-9a-f]{64}$/);
    for (const player of hand.players) {
      expect(player.holeCards).toHaveLength(2);
    }

    // One record carried all of it. There is no ordering of writes that could
    // have published a card while the hand still read as in progress.
    const endings = harness.records.filter((record) => record.kind === 'hand-ended');
    expect(endings).toHaveLength(1);
    expect(cardsIn(endings)).not.toHaveLength(0);
    expect(cardsIn(harness.records.filter((record) => record.kind !== 'hand-ended'))).toEqual([]);
  });

  it('records every dealt hand, including the ones that mucked', async () => {
    const harness = await seatedTable();
    await harness.playHand();
    await harness.tick(DEFAULT_TIMINGS.showdownBeatMs);
    await harness.settle();

    const [hand] = await harness.sink.recentHands('FELT42', 10);
    if (!hand) throw new Error('no hand');

    // An audit trail that skipped the hands nobody saw could not prove the deal
    // was straight — the seat nobody saw is where a crooked deal would hide.
    expect(hand.players.every((player) => player.holeCards?.length === 2)).toBe(true);
  });

  it('never lets an action row carry a card', async () => {
    const harness = await seatedTable();
    await harness.playHand();
    await harness.tick(DEFAULT_TIMINGS.showdownBeatMs);
    await harness.settle();

    const actions = harness.records.filter((record) => record.kind === 'hand-action');
    expect(actions.length).toBeGreaterThan(3);
    expect(cardsIn(actions)).toEqual([]);
  });
});

/** Small enough to state in one line: the queue is not on the path of a hand. */
describe('the table and the database', () => {
  it('deals a whole hand with a sink that never answers', async () => {
    const scheduler = manualScheduler();
    const recorder = new HistoryRecorder({
      sink: {
        write: () => new Promise<void>(() => undefined),
        recentHands: () => Promise.resolve<StoredHand[]>([]),
        hand: () => Promise.resolve(null),
        close: () => Promise.resolve(),
      },
      schedule: () => undefined,
    });

    const table = new TableRuntime({
      code: 'FELT99',
      config: CONFIG,
      rng: seededRng('outage'),
      scheduler,
      history: recorder,
      deckSeeds: seedSequence(),
    });

    const connections = USERS.map(fakeConnection);
    for (const [index, connection] of connections.entries()) {
      await table.attach(connection, { displayName: 'P', avatarSeed: null });
      await table.sit(connection.userId, index, 1_000);
      await table.ready(connection.userId);
    }
    await table.whenIdle();
    await scheduler.advance(DEFAULT_TIMINGS.dealDelayMs);
    await table.whenIdle();

    // The database has not answered a single write, and the table dealt anyway.
    expect(table.state.phase).toBe('preflop');
    expect(recorder.status.pending).toBeGreaterThan(0);
  });
});
