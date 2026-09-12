/**
 * The runtime on its own: the clock, the queue, and the codes.
 *
 * These drive a TableRuntime directly with fake connections, so thirty seconds
 * of action timer costs nothing and the assertions are about the table rather
 * than about sockets.
 */
import { describe, expect, it } from 'vitest';
import { seededRng, type TableState } from '@poker/engine';
import { TABLE_CODE_ALPHABET, type TableConfig } from '@poker/shared';
import type { Connection } from '../src/table/broadcast';
import { generateTableCode } from '../src/table/codes';
import { TableRegistry } from '../src/table/registry';
import { DEFAULT_TIMINGS, TableRuntime, type Scheduler } from '../src/table/runtime';

const CONFIG: TableConfig = {
  seatCount: 6,
  smallBlind: 5,
  bigBlind: 10,
  minBuyIn: 200,
  maxBuyIn: 2_000,
  actionTimeoutSec: 30,
};

interface FakeConnection extends Connection {
  readonly events: { event: string; payload: unknown }[];
  latest<T>(event: string): T | null;
  disconnected: boolean;
}

function fakeConnection(userId: string, socketId = `socket-${userId}`): FakeConnection {
  const events: { event: string; payload: unknown }[] = [];
  const connection: FakeConnection = {
    socketId,
    userId,
    events,
    disconnected: false,
    emit(event, payload) {
      events.push({ event, payload });
    },
    disconnect() {
      connection.disconnected = true;
    },
    latest<T>(event: string): T | null {
      const matches = events.filter((entry) => entry.event === event);
      const last = matches[matches.length - 1];
      return last ? (last.payload as T) : null;
    },
  };
  return connection;
}

interface ManualScheduler extends Scheduler {
  advance(ms: number): void;
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
    advance(ms) {
      now += ms;
      const due = tasks.filter((task) => task.at <= now);
      tasks = tasks.filter((task) => task.at > now);
      for (const task of due) task.run();
    },
  };
}

interface Harness {
  table: TableRuntime;
  scheduler: ManualScheduler;
  connections: FakeConnection[];
  state(): TableState;
  prompt(): { seatIndex: number; actionSeq: number; deadlineTs: number; handId: string };
}

async function seatedTable(players = 2): Promise<Harness> {
  const scheduler = manualScheduler();
  const table = new TableRuntime({
    code: 'TESTAB',
    config: CONFIG,
    rng: seededRng('runtime-tests'),
    scheduler,
  });

  const connections: FakeConnection[] = [];
  for (let index = 0; index < players; index += 1) {
    const connection = fakeConnection(`user-${String(index)}`);
    connections.push(connection);
    await table.attach(connection, { displayName: `P${String(index)}`, avatarSeed: null });
    await table.sit(connection.userId, index, 1_000);
  }
  for (const connection of connections) await table.ready(connection.userId);
  await table.whenIdle();

  // A table does not deal the instant the second player says they are in: it
  // waits, so people who sat down together land in the same hand. Nothing here
  // is dealt until that pause is over.
  scheduler.advance(DEFAULT_TIMINGS.dealDelayMs);
  await table.whenIdle();

  return {
    table,
    scheduler,
    connections,
    state: () => table.state,
    prompt: () => {
      const first = connections[0];
      if (!first) throw new Error('no connections');
      const prompt = first.latest<{
        seatIndex: number;
        actionSeq: number;
        deadlineTs: number;
        handId: string;
      }>('action:prompt');
      if (!prompt) throw new Error('nobody is on the clock');
      return prompt;
    },
  };
}

describe('the action timer', () => {
  it('puts an absolute deadline on the clock, not a duration', async () => {
    const harness = await seatedTable();

    expect(harness.prompt().deadlineTs).toBe(harness.scheduler.now() + 30_000);
  });

  it('folds a seat that lets the clock run out facing a bet', async () => {
    const harness = await seatedTable();
    const onTheClock = harness.prompt().seatIndex;

    harness.scheduler.advance(30_001);
    await harness.table.whenIdle();

    expect(harness.state().seats[onTheClock]?.status).toBe('folded');
    // Heads-up, that ends the hand there and then.
    expect(harness.state().phase).toBe('hand_end');
    expect(harness.connections[0]?.latest('hand:result')).not.toBeNull();
  });

  it('checks instead of folding when checking is free', async () => {
    const harness = await seatedTable();

    // Heads-up preflop: the button calls, the big blind checks its option.
    const preflop = harness.prompt();
    await harness.table.playerAction(`user-${String(preflop.seatIndex)}`, {
      handId: preflop.handId,
      actionSeq: preflop.actionSeq,
      type: 'CALL',
    });
    const option = harness.prompt();
    await harness.table.playerAction(`user-${String(option.seatIndex)}`, {
      handId: option.handId,
      actionSeq: option.actionSeq,
      type: 'CHECK',
    });
    await harness.table.whenIdle();

    expect(harness.state().phase).toBe('flop');
    const flopSeat = harness.prompt().seatIndex;

    harness.scheduler.advance(30_001);
    await harness.table.whenIdle();

    // A free card is not thrown away: still in the hand, action moved on.
    expect(harness.state().seats[flopSeat]?.status).toBe('active');
    expect(harness.state().toActSeat).not.toBe(flopSeat);
  });

  it('stops the clock when the table closes', async () => {
    const harness = await seatedTable();
    const before = harness.state().phase;

    harness.table.close();
    harness.scheduler.advance(60_000);
    await harness.table.whenIdle();

    expect(harness.state().phase).toBe(before);
  });

  it('ignores a timer that fires for a hand that has moved on', async () => {
    const harness = await seatedTable();
    const stale = harness.prompt();

    await harness.table.playerAction(`user-${String(stale.seatIndex)}`, {
      handId: stale.handId,
      actionSeq: stale.actionSeq,
      type: 'CALL',
    });
    await harness.table.whenIdle();
    const afterCall = harness.state().toActSeat;

    // The first seat's timer, had it not been cancelled, would fire about now.
    harness.scheduler.advance(30_001);
    await harness.table.whenIdle();

    expect(harness.state().seats[stale.seatIndex]?.status).not.toBe('folded');
    expect(afterCall).not.toBeNull();
  });
});

describe('the command queue', () => {
  it('applies everything that arrives in one tick, one at a time', async () => {
    const scheduler = manualScheduler();
    const table = new TableRuntime({
      code: 'QUEUED',
      config: CONFIG,
      rng: seededRng('queue'),
      scheduler,
    });

    const connections = [0, 1, 2].map((index) => fakeConnection(`user-${String(index)}`));
    await Promise.all(
      connections.map((connection) =>
        table.attach(connection, { displayName: connection.userId, avatarSeed: null }),
      ),
    );

    // Three sits fired without waiting: they must all land, in some order.
    await Promise.all(
      connections.map((connection, index) => table.sit(connection.userId, index, 500)),
    );
    await table.whenIdle();

    expect(table.state.seats.filter((seat) => seat !== null)).toHaveLength(3);
    expect(table.version).toBeGreaterThanOrEqual(3);
  });

  it('refuses two players the same seat, whoever gets there second', async () => {
    const scheduler = manualScheduler();
    const table = new TableRuntime({
      code: 'RACERS',
      config: CONFIG,
      rng: seededRng('race'),
      scheduler,
    });

    const a = fakeConnection('user-a');
    const b = fakeConnection('user-b');
    await table.attach(a, { displayName: 'A', avatarSeed: null });
    await table.attach(b, { displayName: 'B', avatarSeed: null });

    const results = await Promise.allSettled([
      table.sit('user-a', 2, 500),
      table.sit('user-b', 2, 500),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(table.state.seats[2]).not.toBeNull();
  });

  it('keeps working after a command is refused', async () => {
    const harness = await seatedTable();

    await expect(harness.table.sit('user-0', 0, 1_000)).rejects.toThrow(/already/);
    const prompt = harness.prompt();
    await harness.table.playerAction(`user-${String(prompt.seatIndex)}`, {
      handId: prompt.handId,
      actionSeq: prompt.actionSeq,
      type: 'CALL',
    });

    expect(harness.table.actionSeq).toBe(prompt.actionSeq + 1);
  });
});

describe('one socket per user', () => {
  it('replaces the earlier socket and tells it so', async () => {
    const harness = await seatedTable();
    const original = harness.connections[0];
    if (!original) throw new Error('no connection');

    const replacement = fakeConnection('user-0', 'socket-user-0-second');
    await harness.table.attach(replacement, { displayName: 'P0', avatarSeed: null });

    expect(original.latest('session:replaced')).toEqual({
      message: 'this table was opened somewhere else',
    });
    expect(original.disconnected).toBe(true);
    // The replacement is caught up, private cards and all.
    expect(replacement.latest('state:sync')).not.toBeNull();
    expect(replacement.latest('hand:dealt')).not.toBeNull();
  });

  it('leaves the seat alone when a socket merely drops', async () => {
    const harness = await seatedTable();
    const before = harness.state().seats[0];

    harness.table.detach('socket-user-0');
    await harness.table.whenIdle();

    expect(harness.state().seats[0]).toEqual(before);
    expect(harness.table.memberCount).toBe(1);
  });
});

describe('table codes', () => {
  it('are six characters from an alphabet with no lookalikes', () => {
    const rng = seededRng('codes');

    for (let i = 0; i < 200; i += 1) {
      const code = generateTableCode(rng);
      expect(code).toHaveLength(6);
      expect(code).not.toMatch(/[O0I1]/);
      for (const character of code) expect(TABLE_CODE_ALPHABET).toContain(character);
    }
  });

  it('are not handed out twice', () => {
    const registry = new TableRegistry({ rng: seededRng('registry') });
    const codes = new Set<string>();

    for (let i = 0; i < 50; i += 1) codes.add(registry.create(CONFIG).code);

    expect(codes.size).toBe(50);
    expect(registry.size).toBe(50);
    registry.closeAll();
  });

  it('are found case-insensitively, and refused when unknown', () => {
    const registry = new TableRegistry({ rng: seededRng('lookup') });
    const table = registry.create(CONFIG);

    expect(registry.get(table.code.toLowerCase())).toBe(table);
    expect(() => registry.require('ZZZZZZ')).toThrow(/no table with the code/);
    registry.closeAll();
  });
});
