/**
 * The LIVE board: this table, this sitting, from memory and nowhere else.
 *
 * These drive a real `TableRuntime` with fake connections and a scheduler the
 * test winds forward, so the board is asserted on exactly the payloads a
 * browser would receive — `state:sync` for a whole state, `state:patch` for the
 * deltas in between.
 */
import { describe, expect, it } from 'vitest';
import { seededRng } from '@poker/engine';
import type {
  LiveLeaderboardRow,
  StatePatchPayload,
  StateSyncPayload,
  TableConfig,
} from '@poker/shared';
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

/** Three players checking every street put exactly this in the middle. */
const THREE_HANDED_POT = 30;

interface FakeConnection extends Connection {
  latest<T>(event: string): T | null;
  /**
   * The board as this socket last saw it, from whichever of `state:sync` and
   * `state:patch` arrived most recently.
   *
   * Which one that is matters: a whole state only goes out when somebody sits,
   * leaves, rebuys or a hand is dealt, and everything in between is a patch. A
   * test that read only the syncs would be asserting on the stacks as the hand
   * began, which is exactly the staleness the board on the patch exists to
   * avoid.
   */
  boardNow(): readonly LiveLeaderboardRow[];
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
      /* a test connection is never replaced */
    },
    latest<T>(event: string): T | null {
      const matches = events.filter((entry) => entry.event === event);
      const last = matches[matches.length - 1];
      return last ? (last.payload as T) : null;
    },
    boardNow(): readonly LiveLeaderboardRow[] {
      for (let index = events.length - 1; index >= 0; index -= 1) {
        const entry = events[index];
        if (entry === undefined) continue;

        if (entry.event === 'state:sync') {
          return (entry.payload as StateSyncPayload).state.leaderboard;
        }
        if (entry.event === 'state:patch') {
          const board = (entry.payload as StatePatchPayload).leaderboard;
          if (board !== undefined) return board;
        }
      }
      return [];
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

interface Prompt {
  handId: string;
  seatIndex: number;
  actionSeq: number;
  legalActions: { canCheck: boolean; canCall: boolean };
}

interface Harness {
  table: TableRuntime;
  /** The board as this connection last saw it, sync or patch. */
  board(who?: number): readonly LiveLeaderboardRow[];
  /** The board that rode along on the last patch. */
  patchBoard(who?: number): readonly LiveLeaderboardRow[] | undefined;
  /** Check when it is free, call when it is not. Never folds. */
  playHand(): Promise<void>;
  /** Play the hand out and let the showdown and the payout happen. */
  finishHand(): Promise<void>;
  tick(ms: number): Promise<void>;
}

function seedSequence(): () => string {
  let nth = 0;
  return () => {
    nth += 1;
    return Buffer.from(`board-${String(nth)}`.padEnd(32, '.'), 'utf8').toString('hex');
  };
}

/**
 * A table with players sitting down.
 *
 * `deal: false` stops short of dealing, which is the only moment every stack is
 * still exactly what was bought in — the blinds are out of two of them from the
 * first hand onwards.
 */
async function seatedTable(
  buyIns: readonly number[],
  options: { deal?: boolean } = {},
): Promise<Harness> {
  const scheduler = manualScheduler();
  const table = new TableRuntime({
    code: 'TESTAB',
    config: CONFIG,
    rng: seededRng('board-tests'),
    scheduler,
    deckSeeds: seedSequence(),
  });

  const connections: FakeConnection[] = [];
  for (const [index, buyIn] of buyIns.entries()) {
    const connection = fakeConnection(`user-${String(index)}`);
    connections.push(connection);
    await table.attach(connection, { displayName: `P${String(index)}`, avatarSeed: null });
    await table.sit(connection.userId, index, buyIn);
    if (options.deal !== false) await table.ready(connection.userId);
  }
  await table.whenIdle();

  const at = (who = 0): FakeConnection => {
    const connection = connections[who];
    if (!connection) throw new Error(`no connection ${String(who)}`);
    return connection;
  };

  const prompt = (): Prompt | null => {
    const latest = at().latest<Prompt>('action:prompt');
    if (!latest) return null;
    if (table.state.handId !== latest.handId) return null;
    if (table.state.toActSeat !== latest.seatIndex) return null;
    return latest;
  };

  const tick = async (ms: number): Promise<void> => {
    await scheduler.advance(ms);
    await table.whenIdle();
  };

  const playHand = async (): Promise<void> => {
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
  };

  const harness: Harness = {
    table,
    board: (who = 0) => at(who).boardNow(),
    patchBoard: (who = 0) => at(who).latest<StatePatchPayload>('state:patch')?.leaderboard,
    tick,
    playHand,
    async finishHand(): Promise<void> {
      await playHand();
      // The beat between the cards going face up and the chips moving. Short of
      // the deal delay, so the next hand has not started when this returns.
      await tick(DEFAULT_TIMINGS.showdownBeatMs);
      await playHand();
      await tick(0);
    },
  };

  if (options.deal !== false) await harness.tick(DEFAULT_TIMINGS.dealDelayMs);
  return harness;
}

describe('who is on the board', () => {
  it('has a row per seated player, biggest stack first', async () => {
    const harness = await seatedTable([500, 1_000, 300], { deal: false });
    const board = harness.board();

    expect(board.map((row) => row.seatIndex)).toEqual([1, 0, 2]);
    expect(board.map((row) => row.stack)).toEqual([1_000, 500, 300]);
    expect(board.map((row) => row.displayName)).toEqual(['P1', 'P0', 'P2']);
  });

  it('breaks a tie by seat, so equal stacks do not swap places every patch', async () => {
    const harness = await seatedTable([1_000, 1_000, 1_000], { deal: false });

    expect(harness.board().map((row) => row.seatIndex)).toEqual([0, 1, 2]);
  });

  it('shows the same board to everybody at the table', async () => {
    const harness = await seatedTable([1_000, 800, 600]);

    expect(harness.board(1)).toEqual(harness.board(0));
    expect(harness.board(2)).toEqual(harness.board(0));
  });

  it('drops a player who stands up', async () => {
    const harness = await seatedTable([1_000, 1_000, 1_000]);
    await harness.finishHand();

    await harness.table.leave('user-2');
    await harness.table.whenIdle();

    expect(harness.board().some((row) => row.userId === 'user-2')).toBe(false);
    expect(harness.board()).toHaveLength(2);
  });
});

describe('net, for this sitting', () => {
  it('starts at zero for everybody who has just sat down', async () => {
    const harness = await seatedTable([500, 1_000], { deal: false });

    expect(harness.board().map((row) => row.net)).toEqual([0, 0]);
  });

  it('is measured against the buy-in rather than the last stack', async () => {
    const harness = await seatedTable([1_000, 1_000, 1_000]);
    await harness.finishHand();

    const board = harness.board();
    // A hand of poker is zero-sum, so the nets must be too.
    expect(board.reduce((total, row) => total + row.net, 0)).toBe(0);

    for (const row of board) {
      const seat = harness.table.state.seats[row.seatIndex];
      expect(row.stack).toBe(seat?.stack);
      expect(row.net).toBe((seat?.stack ?? 0) - 1_000);
    }
  });

  it('treats a rebuy as chips from outside the game, so net does not jump', async () => {
    const harness = await seatedTable([400, 1_000]);
    await harness.finishHand();

    const before = harness.board().find((row) => row.seatIndex === 0);
    await harness.table.rebuy('user-0', 200);
    await harness.table.whenIdle();
    const after = harness.board().find((row) => row.seatIndex === 0);

    expect(after?.stack).toBe((before?.stack ?? 0) + 200);
    expect(after?.net).toBe(before?.net);
  });

  it('starts the count again when a player sits back down', async () => {
    const harness = await seatedTable([1_000, 1_000, 1_000]);
    await harness.finishHand();

    await harness.table.leave('user-2');
    await harness.table.whenIdle();
    await harness.table.sit('user-2', 2, 500);
    await harness.table.whenIdle();

    const row = harness.board().find((row) => row.userId === 'user-2');
    expect(row?.stack).toBe(500);
    expect(row?.net).toBe(0);
  });
});

describe('hands won, this sitting', () => {
  it('counts the hand and the pot it was worth', async () => {
    const harness = await seatedTable([1_000, 1_000, 1_000]);
    await harness.finishHand();

    const board = harness.board();
    const winners = board.filter((row) => row.handsWon > 0);

    expect(winners.length).toBeGreaterThanOrEqual(1);
    // Whoever won, the hand is counted once and the pot is the one they took.
    for (const winner of winners) {
      expect(winner.handsWon).toBe(1);
      expect(winner.biggestPot).toBeGreaterThan(0);
      expect(winner.biggestPot).toBeLessThanOrEqual(THREE_HANDED_POT);
    }

    const counted = board.reduce((total, row) => total + row.biggestPot, 0);
    expect(counted).toBe(THREE_HANDED_POT);
  });

  it('keeps the biggest rather than the latest', async () => {
    const harness = await seatedTable([1_000, 1_000, 1_000]);
    await harness.finishHand();

    const afterOne = harness.board();
    const biggest = Math.max(...afterOne.map((row) => row.biggestPot));

    await harness.tick(DEFAULT_TIMINGS.dealDelayMs);
    await harness.finishHand();

    const afterTwo = harness.board();
    expect(Math.max(...afterTwo.map((row) => row.biggestPot))).toBeGreaterThanOrEqual(biggest);
    expect(afterTwo.reduce((total, row) => total + row.handsWon, 0)).toBe(2);
  });
});

describe('how the board travels', () => {
  it('rides along on every patch, so a stack that moves is a board that moves', async () => {
    const harness = await seatedTable([1_000, 1_000, 1_000]);

    const onPatch = harness.patchBoard();
    expect(onPatch).toBeDefined();
    expect(onPatch).toHaveLength(3);

    const stacks = new Map(
      harness.table.state.seats
        .filter((seat) => seat !== null)
        .map((seat) => [seat.seatIndex, seat.stack]),
    );

    for (const row of onPatch ?? []) {
      expect(row.stack).toBe(stacks.get(row.seatIndex));
    }
  });

  /**
   * The board is table state, and table state leaves through one function
   * (CLAUDE.md §1). Nothing in it is a card, and this is what says so.
   */
  it('carries no cards, at any point in a hand', async () => {
    const harness = await seatedTable([1_000, 1_000, 1_000]);
    await harness.finishHand();

    for (const board of [harness.board(), harness.patchBoard() ?? []]) {
      for (const row of board) {
        expect(Object.keys(row).sort()).toEqual([
          'avatarSeed',
          'biggestPot',
          'displayName',
          'handsWon',
          'net',
          'seatIndex',
          'stack',
          'userId',
        ]);
      }
    }
  });
});
