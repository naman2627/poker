/**
 * redactFor(), on its own, and the structural rule around it: exactly one file
 * in the codebase may put table state on a socket, and it is the one that calls
 * this function.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTable, reduce, seededRng, type Command, type TableState } from '@poker/engine';
import { PublicTableStateSchema } from '@poker/shared';
import { redactFor } from '../src/table/redact';

// Real user ids are uuids, and the wire schema insists on it.
const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const CARLA = '33333333-3333-4333-8333-333333333333';

/** A three-handed table, dealt, with the players sitting in seats 0, 1 and 2. */
function dealtTable(extra: readonly Command[] = []): TableState {
  const rng = seededRng('redaction');
  let state = createTable({ seatCount: 6, smallBlind: 5, bigBlind: 10 });

  const commands: Command[] = [
    { type: 'SIT', seatIndex: 0, playerId: ALICE, stack: 1_000 },
    { type: 'SIT', seatIndex: 1, playerId: BOB, stack: 1_000 },
    { type: 'SIT', seatIndex: 2, playerId: CARLA, stack: 1_000 },
    { type: 'START_HAND', handId: '11111111-2222-4333-8444-555555555555' },
    { type: 'POST_BLINDS' },
    { type: 'DEAL_HOLE' },
    ...extra,
  ];

  for (const command of commands) state = reduce(state, command, rng).state;
  return state;
}

/** Every card anywhere in a value. */
function cardsIn(value: unknown): string[] {
  const found: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (typeof node !== 'object' || node === null) return;
    const record = node as Record<string, unknown>;
    if (typeof record.rank === 'number' && typeof record.suit === 'string') {
      found.push(`${String(record.rank)}${record.suit}`);
      return;
    }
    for (const item of Object.values(record)) walk(item);
  };
  walk(value);
  return found;
}

describe('redactFor', () => {
  it('gives a player their own cards and nobody else theirs', () => {
    const state = dealtTable();
    const view = redactFor(state, ALICE);

    expect(view.seats[0]?.holeCards).toHaveLength(2);
    expect(view.seats[1]?.holeCards).toBeNull();
    expect(view.seats[2]?.holeCards).toBeNull();
    expect(view.viewerSeatIndex).toBe(0);
  });

  it('shows a watcher no hand at all', () => {
    const state = dealtTable();
    const view = redactFor(state, null);

    expect(view.seats.every((seat) => seat === null || seat.holeCards === null)).toBe(true);
    expect(view.viewerSeatIndex).toBeNull();
    expect(cardsIn(view)).toHaveLength(0);
  });

  it('still says how many cards a hidden seat is holding', () => {
    const view = redactFor(dealtTable(), ALICE);

    expect(view.seats[1]?.cardCount).toBe(2);
    expect(view.seats[1]?.holeCards).toBeNull();
  });

  it('never carries the deck, only a count of it', () => {
    const state = dealtTable();
    const view = redactFor(state, ALICE);

    expect(JSON.stringify(view)).not.toContain('"deck"');
    expect(view.deckRemaining).toBe(state.deck.length);
    expect(view.deckRemaining).toBe(52 - 6);
    // Whatever is in the view, it is not the rest of the deck.
    expect(cardsIn(view).length).toBeLessThanOrEqual(2 + state.board.length);
  });

  it('turns the hands face up once a showdown is reached', () => {
    const state = dealtTable([
      { type: 'PLAYER_ACTION', seatIndex: 0, action: { type: 'CALL' } },
      { type: 'PLAYER_ACTION', seatIndex: 1, action: { type: 'CALL' } },
      { type: 'PLAYER_ACTION', seatIndex: 2, action: { type: 'CHECK' } },
      { type: 'ADVANCE_STREET' },
      { type: 'PLAYER_ACTION', seatIndex: 1, action: { type: 'CHECK' } },
      { type: 'PLAYER_ACTION', seatIndex: 2, action: { type: 'CHECK' } },
      { type: 'PLAYER_ACTION', seatIndex: 0, action: { type: 'CHECK' } },
      { type: 'ADVANCE_STREET' },
      { type: 'PLAYER_ACTION', seatIndex: 1, action: { type: 'CHECK' } },
      { type: 'PLAYER_ACTION', seatIndex: 2, action: { type: 'CHECK' } },
      { type: 'PLAYER_ACTION', seatIndex: 0, action: { type: 'CHECK' } },
      { type: 'ADVANCE_STREET' },
      { type: 'PLAYER_ACTION', seatIndex: 1, action: { type: 'CHECK' } },
      { type: 'PLAYER_ACTION', seatIndex: 2, action: { type: 'CHECK' } },
      { type: 'PLAYER_ACTION', seatIndex: 0, action: { type: 'CHECK' } },
      { type: 'ADVANCE_STREET' },
    ]);

    expect(state.phase).toBe('showdown');

    // Reaching a showdown is not, on its own, what makes a hand public. The
    // server names the seats it turned over, and only those come back.
    const nothingSaid = redactFor(state, ALICE);
    expect(nothingSaid.seats[1]?.holeCards).toBeNull();
    expect(nothingSaid.seats[2]?.holeCards).toBeNull();

    const shown = redactFor(state, ALICE, { revealedSeats: new Set([1, 2]) });
    expect(shown.seats[1]?.holeCards).toHaveLength(2);
    expect(shown.seats[2]?.holeCards).toHaveLength(2);
  });

  it('keeps a mucked hand hidden at a showdown everyone else was shown at', () => {
    const state = dealtTable([
      { type: 'PLAYER_ACTION', seatIndex: 0, action: { type: 'CALL' } },
      { type: 'PLAYER_ACTION', seatIndex: 1, action: { type: 'CALL' } },
      { type: 'PLAYER_ACTION', seatIndex: 2, action: { type: 'CHECK' } },
      { type: 'ADVANCE_STREET' },
      { type: 'PLAYER_ACTION', seatIndex: 1, action: { type: 'CHECK' } },
      { type: 'PLAYER_ACTION', seatIndex: 2, action: { type: 'CHECK' } },
      { type: 'PLAYER_ACTION', seatIndex: 0, action: { type: 'CHECK' } },
      { type: 'ADVANCE_STREET' },
      { type: 'PLAYER_ACTION', seatIndex: 1, action: { type: 'CHECK' } },
      { type: 'PLAYER_ACTION', seatIndex: 2, action: { type: 'CHECK' } },
      { type: 'PLAYER_ACTION', seatIndex: 0, action: { type: 'CHECK' } },
      { type: 'ADVANCE_STREET' },
      { type: 'PLAYER_ACTION', seatIndex: 1, action: { type: 'CHECK' } },
      { type: 'PLAYER_ACTION', seatIndex: 2, action: { type: 'CHECK' } },
      { type: 'PLAYER_ACTION', seatIndex: 0, action: { type: 'CHECK' } },
      { type: 'ADVANCE_STREET' },
    ]);

    // Seat 1 mucked; seats 0 and 2 showed. Bob sees his own cards and the ones
    // that were turned over, and nothing of seat 1's.
    const view = redactFor(state, CARLA, {
      revealedSeats: new Set([0, 2]),
      muckedSeats: new Set([1]),
    });

    expect(view.seats[0]?.holeCards).toHaveLength(2);
    expect(view.seats[2]?.holeCards).toHaveLength(2);
    expect(view.seats[1]?.holeCards).toBeNull();
    expect(view.muckedSeats).toEqual([1]);
    expect(cardsIn(view.seats[1])).toHaveLength(0);
  });

  it('keeps a folded hand hidden even at the showdown', () => {
    const state = dealtTable([
      { type: 'PLAYER_ACTION', seatIndex: 0, action: { type: 'FOLD' } },
      { type: 'PLAYER_ACTION', seatIndex: 1, action: { type: 'CALL' } },
      { type: 'PLAYER_ACTION', seatIndex: 2, action: { type: 'CHECK' } },
      { type: 'ADVANCE_STREET' },
      { type: 'PLAYER_ACTION', seatIndex: 1, action: { type: 'CHECK' } },
      { type: 'PLAYER_ACTION', seatIndex: 2, action: { type: 'CHECK' } },
      { type: 'ADVANCE_STREET' },
      { type: 'PLAYER_ACTION', seatIndex: 1, action: { type: 'CHECK' } },
      { type: 'PLAYER_ACTION', seatIndex: 2, action: { type: 'CHECK' } },
      { type: 'ADVANCE_STREET' },
      { type: 'PLAYER_ACTION', seatIndex: 1, action: { type: 'CHECK' } },
      { type: 'PLAYER_ACTION', seatIndex: 2, action: { type: 'CHECK' } },
      { type: 'ADVANCE_STREET' },
    ]);

    expect(state.phase).toBe('showdown');
    const view = redactFor(state, BOB, { revealedSeats: new Set([1, 2]) });

    expect(view.seats[0]?.status).toBe('folded');
    expect(view.seats[0]?.holeCards).toBeNull();
    expect(view.seats[2]?.holeCards).toHaveLength(2);
  });

  it('shows nothing when everybody folded, however far the phase has gone', () => {
    const state = dealtTable([
      { type: 'PLAYER_ACTION', seatIndex: 0, action: { type: 'FOLD' } },
      { type: 'PLAYER_ACTION', seatIndex: 1, action: { type: 'FOLD' } },
    ]);

    expect(state.phase).toBe('payout');
    const view = redactFor(state, ALICE);

    // A hand nobody called is never shown, not even after it is paid.
    expect(view.seats[2]?.holeCards).toBeNull();
    expect(view.seats[1]?.holeCards).toBeNull();
  });

  it('produces a payload that matches the shared schema', () => {
    const view = redactFor(dealtTable(), ALICE, {
      tableCode: 'ABCDEF',
      members: new Map([[ALICE, { displayName: 'Alice', avatarSeed: 'seed' }]]),
      actionDeadlineTs: 1_700_000_030_000,
      hostUserId: ALICE,
      paused: false,
    });

    expect(() => PublicTableStateSchema.parse(view)).not.toThrow();
    expect(view.seats[0]?.displayName).toBe('Alice');
    expect(view.seats[0]?.isReady).toBe(true);
    expect(view.seats[0]?.sittingOut).toBe(false);
    expect(view.hostUserId).toBe(ALICE);
    expect(view.actionDeadlineTs).toBe(1_700_000_030_000);
  });

  it('cannot be talked into revealing a hand by the context it is given', () => {
    const state = dealtTable();
    const view = redactFor(state, ALICE, {
      members: new Map([[BOB, { displayName: 'Bob', avatarSeed: null }]]),
      muckedSeats: new Set([0, 1, 2]),
      hostUserId: BOB,
      paused: true,
    });

    // Decoration cannot turn a card over. Only `revealedSeats` does that, and
    // only for the seats the server actually put in it.
    expect(view.seats[1]?.holeCards).toBeNull();
    expect(view.seats[2]?.holeCards).toBeNull();
    expect(view.seats[1]?.displayName).toBe('Bob');
  });

  it('reports a seat on its way out without giving anything else away', () => {
    const state = dealtTable([{ type: 'LEAVE', seatIndex: 1 }]);
    const view = redactFor(state, ALICE);

    expect(view.seats[1]?.leaving).toBe(true);
    expect(view.seats[0]?.leaving).toBe(false);
    expect(view.seats[1]?.holeCards).toBeNull();
  });
});

describe('the one exit path', () => {
  const sourceRoot = join(import.meta.dirname, '..', 'src');

  function sourceFiles(directory: string): string[] {
    return readdirSync(directory).flatMap((entry) => {
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) return sourceFiles(path);
      return path.endsWith('.ts') ? [path] : [];
    });
  }

  /** Comments talk about the rule; only code can break it. */
  function codeOf(path: string): string {
    return readFileSync(path, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
  }

  it('has exactly one file that calls redactFor', () => {
    const callers = sourceFiles(sourceRoot).filter((path) => {
      const code = codeOf(path);
      const declaresIt = /export function redactFor/.test(code);
      return !declaresIt && /redactFor\s*\(/.test(code);
    });

    expect(callers.map((path) => path.replace(sourceRoot, '').replaceAll('\\', '/'))).toEqual([
      '/table/broadcast.ts',
    ]);
  });

  it('has exactly one file that emits table state', () => {
    const senders = sourceFiles(sourceRoot).filter((path) =>
      /SERVER_EVENTS\.(stateSync|statePatch|handDealt)/.test(codeOf(path)),
    );

    expect(senders.map((path) => path.replace(sourceRoot, '').replaceAll('\\', '/'))).toEqual([
      '/table/broadcast.ts',
    ]);
  });

  it('keeps raw state event names out of every other file', () => {
    for (const path of sourceFiles(sourceRoot)) {
      const mentionsRawEvent = /'state:(sync|patch)'|"state:(sync|patch)"/.test(codeOf(path));
      expect(mentionsRawEvent, `${path} names a state event directly`).toBe(false);
    }
  });

  it('never lets the runtime reach a socket except through broadcast.ts', () => {
    const runtime = readFileSync(join(sourceRoot, 'table', 'runtime.ts'), 'utf8');

    // Everything it sends goes through an imported sender.
    expect(runtime).not.toMatch(/\.emit\s*\(/);
    expect(runtime).toMatch(/from '\.\/broadcast'/);
  });
});
