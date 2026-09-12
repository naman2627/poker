/**
 * The loop a table runs on its own: deal, play, show, pay, deal again.
 *
 * These drive a `TableRuntime` directly with fake connections and a scheduler a
 * test can wind forward, so the two-second showdown beat and the pause before a
 * deal cost nothing and are still the real ones.
 */
import { describe, expect, it } from 'vitest';
import { seededRng, type TableState } from '@poker/engine';
import type { TableConfig } from '@poker/shared';
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

interface FakeConnection extends Connection {
  readonly events: { event: string; payload: unknown }[];
  latest<T>(event: string): T | null;
  of(event: string): unknown[];
  disconnected: boolean;
}

function fakeConnection(userId: string): FakeConnection {
  const events: { event: string; payload: unknown }[] = [];
  const connection: FakeConnection = {
    socketId: `socket-${userId}`,
    userId,
    events,
    disconnected: false,
    emit(event, payload) {
      events.push({ event, payload });
    },
    disconnect() {
      connection.disconnected = true;
    },
    of: (event: string) => events.filter((entry) => entry.event === event).map((e) => e.payload),
    latest<T>(event: string): T | null {
      const matches = events.filter((entry) => entry.event === event);
      const last = matches[matches.length - 1];
      return last ? (last.payload as T) : null;
    },
  };
  return connection;
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
      // Timers enqueue work; give the queue a turn to drain before asserting.
      await Promise.resolve();
    },
  };
}

interface Prompt {
  handId: string;
  seatIndex: number;
  actionSeq: number;
  legalActions: { canCheck: boolean; canCall: boolean; canFold: boolean };
  deadlineTs: number;
}

interface Harness {
  table: TableRuntime;
  scheduler: ManualScheduler;
  connections: FakeConnection[];
  state(): TableState;
  prompt(): Prompt | null;
  /** Check when it is free, call when it is not. Never folds. */
  playHand(): Promise<void>;
  tick(ms: number): Promise<void>;
}

/**
 * A fixed sequence of deck seeds.
 *
 * Production draws 32 random bytes a hand; a test that wants to assert on the
 * cards needs the same deck every run, so it hands over a counter instead. The
 * shuffle is the real one either way.
 */
function seedSequence(prefix = 'test'): () => string {
  let nth = 0;
  return () => {
    nth += 1;
    return Buffer.from(`${prefix}-${String(nth)}`.padEnd(32, '.'), 'utf8').toString('hex');
  };
}

async function seatedTable(players = 3, hostUserId = 'user-0'): Promise<Harness> {
  const scheduler = manualScheduler();
  const table = new TableRuntime({
    code: 'TESTAB',
    config: CONFIG,
    rng: seededRng('loop-tests'),
    scheduler,
    hostUserId,
    deckSeeds: seedSequence(),
  });

  const connections: FakeConnection[] = [];
  for (let index = 0; index < players; index += 1) {
    const connection = fakeConnection(`user-${String(index)}`);
    connections.push(connection);
    await table.attach(connection, { displayName: `P${String(index)}`, avatarSeed: null });
    await table.sit(connection.userId, index, 1_000);
    await table.ready(connection.userId);
  }
  await table.whenIdle();

  const tick = async (ms: number): Promise<void> => {
    await scheduler.advance(ms);
    await table.whenIdle();
  };

  const prompt = (): Prompt | null => {
    const first = connections[0];
    if (!first) throw new Error('no connections');
    const latest = first.latest<Prompt>('action:prompt');
    if (!latest) return null;
    if (table.state.handId !== latest.handId) return null;
    if (table.state.toActSeat !== latest.seatIndex) return null;
    return latest;
  };

  const harness: Harness = {
    table,
    scheduler,
    connections,
    state: () => table.state,
    prompt,
    tick,
    async playHand(): Promise<void> {
      for (let step = 0; step < 60; step += 1) {
        const current = prompt();
        if (current === null) break;
        const actor = connections[current.seatIndex];
        if (!actor) throw new Error(`no player in seat ${String(current.seatIndex)}`);

        await table.playerAction(actor.userId, {
          handId: current.handId,
          actionSeq: current.actionSeq,
          type: current.legalActions.canCheck ? 'CHECK' : 'CALL',
        });
        await table.whenIdle();
      }
    },
  };

  await harness.tick(DEFAULT_TIMINGS.dealDelayMs);
  return harness;
}

describe('sitting down and being dealt in', () => {
  it('deals nobody in until they say they are in', async () => {
    const scheduler = manualScheduler();
    const table = new TableRuntime({
      code: 'TESTAB',
      config: CONFIG,
      rng: seededRng('loop-tests'),
      scheduler,
    });

    for (const index of [0, 1]) {
      const connection = fakeConnection(`user-${String(index)}`);
      await table.attach(connection, { displayName: 'P', avatarSeed: null });
      await table.sit(connection.userId, index, 1_000);
    }
    await table.whenIdle();
    await scheduler.advance(DEFAULT_TIMINGS.dealDelayMs * 4);
    await table.whenIdle();

    // Two seats, both funded, and no hand: taking a chair is not joining a game.
    expect(table.state.phase).toBe('waiting');
    expect(table.state.seats[0]?.sittingOut).toBe(true);
  });

  it('waits before dealing, so players who sat together get the same hand', async () => {
    const scheduler = manualScheduler();
    const table = new TableRuntime({
      code: 'TESTAB',
      config: CONFIG,
      rng: seededRng('loop-tests'),
      scheduler,
    });

    const connections = [0, 1, 2].map((index) => fakeConnection(`user-${String(index)}`));
    for (const [index, connection] of connections.entries()) {
      await table.attach(connection, { displayName: 'P', avatarSeed: null });
      await table.sit(connection.userId, index, 1_000);
    }
    // The first two say they are in. Nothing is dealt yet.
    await table.ready('user-0');
    await table.ready('user-1');
    await table.whenIdle();
    expect(table.state.phase).toBe('waiting');

    // The third makes it in under the wire.
    await table.ready('user-2');
    await scheduler.advance(DEFAULT_TIMINGS.dealDelayMs);
    await table.whenIdle();

    expect(table.state.dealtInSeats).toEqual([0, 1, 2]);
  });
});

describe('hand after hand', () => {
  it('deals the next hand without anyone asking again', async () => {
    const harness = await seatedTable(3);
    expect(harness.state().handNumber).toBe(1);

    await harness.playHand();
    await harness.tick(DEFAULT_TIMINGS.showdownBeatMs);
    expect(harness.state().phase).toBe('hand_end');

    await harness.tick(DEFAULT_TIMINGS.dealDelayMs);
    expect(harness.state().handNumber).toBe(2);
    expect(harness.state().phase).toBe('preflop');
  });

  it('moves the button on every hand', async () => {
    const harness = await seatedTable(3);
    const buttons: (number | null)[] = [];

    for (let hand = 0; hand < 6; hand += 1) {
      buttons.push(harness.state().buttonSeat);
      await harness.playHand();
      await harness.tick(DEFAULT_TIMINGS.showdownBeatMs);
      await harness.tick(DEFAULT_TIMINGS.dealDelayMs);
    }

    // Three-handed, the button goes round one seat at a time and wraps.
    expect(buttons).toEqual([0, 1, 2, 0, 1, 2]);
  });

  it('plays twenty hands without losing a chip or getting stuck', async () => {
    const harness = await seatedTable(3);
    const total = (): number =>
      harness.state().seats.reduce((sum, seat) => sum + (seat?.stack ?? 0), 0) +
      harness.state().pots.reduce((sum, pot) => sum + pot.amount, 0);

    expect(total()).toBe(3_000);

    for (let hand = 0; hand < 20; hand += 1) {
      await harness.playHand();
      await harness.tick(DEFAULT_TIMINGS.showdownBeatMs);
      await harness.tick(DEFAULT_TIMINGS.dealDelayMs);
      expect(total()).toBe(3_000);
    }

    expect(harness.state().handNumber).toBe(21);
  });
});

describe('the showdown beat', () => {
  it('turns the cards over, then waits before the chips move', async () => {
    const harness = await seatedTable(3);
    await harness.playHand();

    // Cards are face up and the phase has stopped at the showdown.
    expect(harness.state().phase).toBe('showdown');
    const watcher = harness.connections[0];
    expect(watcher?.of('hand:result')).toHaveLength(0);

    // A moment short of the beat, still nothing.
    await harness.tick(DEFAULT_TIMINGS.showdownBeatMs - 1);
    expect(harness.state().phase).toBe('showdown');

    await harness.tick(1);
    expect(watcher?.of('hand:result')).toHaveLength(1);
  });

  it('never sends a mucked hand to anybody but its owner', async () => {
    const harness = await seatedTable(3);
    const muckedSeat = await playUntilSomebodyMucks(harness);

    const result = harness.connections[0]?.latest<{
      revealed: { seatIndex: number }[];
      mucked: { seatIndex: number }[];
    }>('hand:result');
    if (!result) throw new Error('no result');

    expect(result.revealed.map((entry) => entry.seatIndex)).not.toContain(muckedSeat);

    // The state a player who is not in that seat receives has no cards for it.
    const other = harness.connections.find(
      (connection) => connection.userId !== `user-${String(muckedSeat)}`,
    );
    const sync = other?.latest<{
      state: { seats: ({ seatIndex: number; holeCards: unknown } | null)[] };
    }>('state:sync');
    expect(sync?.state.seats[muckedSeat]?.holeCards).toBeNull();
  });

  it('shows a mucked hand only when its owner asks, and only their own', async () => {
    const harness = await seatedTable(3);
    const muckedSeat = await playUntilSomebodyMucks(harness);

    const handId = harness.state().handId;
    if (handId === null) throw new Error('no hand');

    const result = harness.connections[0]?.latest<{ mucked: { seatIndex: number }[] }>(
      'hand:result',
    );
    const muckedSeats = new Set((result?.mucked ?? []).map((entry) => entry.seatIndex));

    // Somebody with nothing of their own to show cannot ask on another seat's
    // behalf — "show" is about your own cards or it is about nothing.
    const bystander = harness.connections.find(
      (connection, index) => !muckedSeats.has(index) && connection.userId,
    );
    if (!bystander) throw new Error('every seat mucked; nobody left to be refused');

    await expect(harness.table.show(bystander.userId, handId)).rejects.toThrow(
      /nothing of yours left to show/,
    );

    await harness.table.show(`user-${String(muckedSeat)}`, handId);
    await harness.table.whenIdle();

    const sync = bystander.latest<{
      state: { seats: ({ holeCards: unknown[] | null } | null)[] };
    }>('state:sync');
    expect(sync?.state.seats[muckedSeat]?.holeCards).toHaveLength(2);
  });
});

/**
 * Play hands until one of them ends with somebody mucking.
 *
 * Which hands muck depends on the cards, and the cards come from a real shuffle
 * — so the test looks for the situation rather than assuming the first hand
 * happens to be it.
 */
async function playUntilSomebodyMucks(harness: Harness): Promise<number> {
  for (let hand = 0; hand < 25; hand += 1) {
    await harness.playHand();
    await harness.tick(DEFAULT_TIMINGS.showdownBeatMs);

    const result = harness.connections[0]?.latest<{ mucked: { seatIndex: number }[] }>(
      'hand:result',
    );
    const mucked = result?.mucked?.[0]?.seatIndex;
    if (mucked !== undefined) return mucked;

    await harness.tick(DEFAULT_TIMINGS.dealDelayMs);
  }

  throw new Error('twenty-five hands and nobody mucked, which should not happen');
}

describe('pausing', () => {
  it('lets the hand in progress finish and deals no more', async () => {
    const harness = await seatedTable(3);
    await harness.table.pause('user-0', true);
    await harness.table.whenIdle();

    // The hand that was already running plays out.
    await harness.playHand();
    await harness.tick(DEFAULT_TIMINGS.showdownBeatMs);
    expect(harness.state().phase).toBe('hand_end');

    await harness.tick(DEFAULT_TIMINGS.dealDelayMs * 4);
    expect(harness.state().handNumber).toBe(1);
    expect(harness.state().phase).toBe('hand_end');
  });

  it('starts dealing again when the host says so', async () => {
    const harness = await seatedTable(3);
    await harness.table.pause('user-0', true);
    await harness.playHand();
    await harness.tick(DEFAULT_TIMINGS.showdownBeatMs);
    await harness.tick(DEFAULT_TIMINGS.dealDelayMs * 2);
    expect(harness.state().handNumber).toBe(1);

    await harness.table.pause('user-0', false);
    await harness.table.whenIdle();
    await harness.tick(DEFAULT_TIMINGS.dealDelayMs);

    expect(harness.state().handNumber).toBe(2);
  });

  it('refuses anyone but the host', async () => {
    const harness = await seatedTable(3);
    await expect(harness.table.pause('user-1', true)).rejects.toThrow(/only the host/);
    expect(harness.table.paused).toBe(false);
  });
});

describe('sitting out and rebuying', () => {
  it('keeps a player out of the next hand and back in when they ask', async () => {
    const harness = await seatedTable(3);

    await harness.table.setSittingOut('user-2', true);
    await harness.playHand();
    await harness.tick(DEFAULT_TIMINGS.showdownBeatMs);
    await harness.tick(DEFAULT_TIMINGS.dealDelayMs);

    expect(harness.state().dealtInSeats).toEqual([0, 1]);

    await harness.table.setSittingOut('user-2', false);
    await harness.playHand();
    await harness.tick(DEFAULT_TIMINGS.showdownBeatMs);
    await harness.tick(DEFAULT_TIMINGS.dealDelayMs);

    expect(harness.state().dealtInSeats).toEqual([0, 1, 2]);
  });

  it('refuses a rebuy mid-hand, and takes one between hands', async () => {
    const harness = await seatedTable(3);

    await expect(harness.table.rebuy('user-0', 100)).rejects.toThrow(/between hands/);

    await harness.playHand();
    await harness.tick(DEFAULT_TIMINGS.showdownBeatMs);

    const before = harness.state().seats[0]?.stack ?? 0;
    await harness.table.rebuy('user-0', 100);
    await harness.table.whenIdle();

    expect(harness.state().seats[0]?.stack).toBe(before + 100);
  });

  it('refuses a rebuy that would take a stack past the table maximum', async () => {
    const harness = await seatedTable(3);
    await harness.playHand();
    await harness.tick(DEFAULT_TIMINGS.showdownBeatMs);

    await expect(harness.table.rebuy('user-0', 5_000)).rejects.toThrow(/table maximum/);
  });
});

describe('standing up mid-hand', () => {
  it('folds the seat at its next turn and empties it when the hand ends', async () => {
    const harness = await seatedTable(3);
    const toAct = harness.state().toActSeat;
    if (toAct === null) throw new Error('nobody on the clock');

    // Somebody who is not on the clock walks out.
    const leaver = (toAct + 1) % 3;
    await harness.table.leave(`user-${String(leaver)}`);
    await harness.table.whenIdle();

    expect(harness.state().seats[leaver]?.status).toBe('active');
    expect(harness.state().pendingLeave).toEqual([leaver]);

    await harness.playHand();
    await harness.tick(DEFAULT_TIMINGS.showdownBeatMs);

    expect(harness.state().seats[leaver]).toBeNull();
  });
});
