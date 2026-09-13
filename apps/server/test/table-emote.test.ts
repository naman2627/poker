/**
 * Reactions, and who is allowed to make one.
 *
 * The cooldown is the interesting part: it is the server's, measured against
 * the table's own clock, so a client that asks early is refused rather than
 * believed (CLAUDE.md §4).
 */
import { describe, expect, it } from 'vitest';
import { seededRng } from '@poker/engine';
import type { EmotePayload, TableConfig } from '@poker/shared';
import type { Connection } from '../src/table/broadcast';
import { EMOTE_COOLDOWN_MS, TableRuntime, type Scheduler } from '../src/table/runtime';
import { TableError } from '../src/table/errors';

const CONFIG: TableConfig = {
  seatCount: 6,
  smallBlind: 5,
  bigBlind: 10,
  minBuyIn: 200,
  maxBuyIn: 2_000,
  actionTimeoutSec: 30,
};

interface FakeConnection extends Connection {
  emotes(): EmotePayload[];
}

function fakeConnection(userId: string): FakeConnection {
  const events: { event: string; payload: unknown }[] = [];
  return {
    socketId: `socket-${userId}`,
    userId,
    emit(event, payload) {
      events.push({ event, payload });
    },
    disconnect() {
      /* never replaced in a test */
    },
    emotes: () =>
      events.filter((e) => e.event === 'table:emote').map((e) => e.payload as EmotePayload),
  };
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
        tasks = tasks.filter((c) => c !== task);
      };
    },
    advance(ms) {
      now += ms;
      const due = tasks.filter((t) => t.at <= now).sort((a, b) => a.at - b.at);
      tasks = tasks.filter((t) => t.at > now);
      for (const task of due) task.run();
    },
  };
}

async function seated(players = 2) {
  const scheduler = manualScheduler();
  const table = new TableRuntime({
    code: 'TESTAB',
    config: CONFIG,
    rng: seededRng('emote-tests'),
    scheduler,
  });

  const connections: FakeConnection[] = [];
  for (let index = 0; index < players; index += 1) {
    const connection = fakeConnection(`user-${String(index)}`);
    connections.push(connection);
    await table.attach(connection, { displayName: `P${String(index)}`, avatarSeed: null });
    await table.sit(connection.userId, index, 1_000);
  }
  await table.whenIdle();
  return { table, scheduler, connections };
}

describe('reacting', () => {
  it('reaches everybody at the table, with the seat it came from', async () => {
    const { table, connections } = await seated(3);

    await table.emote('user-1', 'clap');
    await table.whenIdle();

    for (const connection of connections) {
      const [only] = connection.emotes();
      expect(only?.emote).toBe('clap');
      expect(only?.userId).toBe('user-1');
      expect(only?.seatIndex).toBe(1);
    }
  });

  it('carries a timestamp from the table clock, not the client', async () => {
    const { table, scheduler, connections } = await seated();
    scheduler.advance(5_000);

    await table.emote('user-0', 'laugh');
    await table.whenIdle();

    expect(connections[0]?.emotes()[0]?.at).toBe(scheduler.now());
  });
});

describe('the cooldown', () => {
  it('refuses a second reaction too soon', async () => {
    const { table } = await seated();

    await table.emote('user-0', 'clap');
    await expect(table.emote('user-0', 'laugh')).rejects.toBeInstanceOf(TableError);
  });

  it('allows it once the cooldown has passed', async () => {
    const { table, scheduler, connections } = await seated();

    await table.emote('user-0', 'clap');
    scheduler.advance(EMOTE_COOLDOWN_MS);
    await table.emote('user-0', 'laugh');
    await table.whenIdle();

    expect(connections[0]?.emotes().map((e) => e.emote)).toEqual(['clap', 'laugh']);
  });

  it('is per player — one person reacting does not silence another', async () => {
    const { table, connections } = await seated(3);

    await table.emote('user-0', 'clap');
    await table.emote('user-1', 'shock');
    await table.emote('user-2', 'salt');
    await table.whenIdle();

    expect(connections[0]?.emotes()).toHaveLength(3);
  });

  /**
   * A cooldown a client owns is a cooldown that does not exist. This is the
   * test that says the server is the one counting.
   */
  it('cannot be skipped by asking faster', async () => {
    const { table, connections } = await seated();

    await table.emote('user-0', 'clap');
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await table.emote('user-0', 'laugh').catch(() => undefined);
    }
    await table.whenIdle();

    expect(connections[0]?.emotes()).toHaveLength(1);
  });

  it('starts again for somebody who stood up and sat back down', async () => {
    const { table, connections } = await seated();

    await table.emote('user-0', 'clap');
    await table.leave('user-0');
    await table.sit('user-0', 0, 1_000);
    await table.emote('user-0', 'laugh');
    await table.whenIdle();

    expect(connections[0]?.emotes()).toHaveLength(2);
  });
});

describe('who may react', () => {
  /**
   * A reaction floats over a chair. Somebody on the rail has no chair — and a
   * table where anybody watching can interrupt is not a table people want.
   */
  it('refuses somebody who is only watching', async () => {
    const { table } = await seated();

    const watcher = fakeConnection('user-watching');
    await table.attach(watcher, { displayName: 'Rail', avatarSeed: null });
    await table.whenIdle();

    await expect(table.emote('user-watching', 'clap')).rejects.toBeInstanceOf(TableError);
    expect(watcher.emotes()).toHaveLength(0);
  });

  it('still lets a watcher see everybody else react', async () => {
    const { table } = await seated();

    const watcher = fakeConnection('user-watching');
    await table.attach(watcher, { displayName: 'Rail', avatarSeed: null });
    await table.emote('user-0', 'salute');
    await table.whenIdle();

    expect(watcher.emotes()[0]?.emote).toBe('salute');
  });
});
