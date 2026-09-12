/**
 * The engine is a pure function of (state, command, rng). This suite is the
 * guard on that claim: no mutation of the caller's state, no ambient randomness,
 * no clock.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createRngFrom, reduce, seededRng, type Command, type TableState } from '../src/index';
import { act, advance, preflop, run, tableWith } from './helpers';

const SIX = [1000, 1000, 1000, 1000, 1000, 1000];

const HAND: Command[] = [
  { type: 'START_HAND', handId: 'hand-1' },
  { type: 'POST_BLINDS' },
  { type: 'DEAL_HOLE' },
  act.raise(3, 30),
  act.fold(4),
  act.fold(5),
  act.fold(0),
  act.fold(1),
  act.call(2),
  advance,
  act.check(2),
  act.bet(3, 50),
  act.call(2),
  advance,
  act.check(2),
  act.check(3),
  advance,
  act.check(2),
  act.check(3),
  advance,
  advance,
  advance,
];

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}

describe('purity', () => {
  it('does not touch the state it was given', () => {
    const before = deepFreeze(preflop(SIX));
    const snapshot = JSON.stringify(before);

    run(before, [act.raise(3, 100), act.fold(4)]);

    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it('survives a whole hand against a frozen state', () => {
    let state: TableState = deepFreeze(tableWith(SIX));
    for (const command of HAND) {
      state = deepFreeze(reduce(state, command, seededRng('frozen')).state);
    }

    expect(state.phase).toBe('hand_end');
  });

  it('returns fresh objects rather than the ones it was handed', () => {
    const before = preflop(SIX);
    const after = run(before, [act.call(3)]);

    expect(after).not.toBe(before);
    expect(after.seats).not.toBe(before.seats);
    expect(after.seats[3]).not.toBe(before.seats[3]);
    expect(after.deck).not.toBe(before.deck);
  });

  it('gives an identical result for identical inputs', () => {
    const play = (): TableState => {
      let state = tableWith(SIX);
      const rng = seededRng('replay');
      for (const command of HAND) state = reduce(state, command, rng).state;
      return state;
    };

    expect(JSON.stringify(play())).toBe(JSON.stringify(play()));
  });

  it('gives an identical event stream for identical inputs', () => {
    const play = (): string => {
      let state = tableWith(SIX);
      const rng = seededRng('replay');
      const events = HAND.flatMap((command) => {
        const result = reduce(state, command, rng);
        state = result.state;
        return result.events;
      });
      return JSON.stringify(events);
    };

    expect(play()).toBe(play());
  });

  it('deals a different hand from a different rng', () => {
    const deal = (seed: string): string => {
      const state = run(tableWith(SIX), HAND.slice(0, 3), seededRng(seed));
      return JSON.stringify([state.seats.map((seat) => seat?.holeCards), state.deck]);
    };

    expect(deal('one')).not.toBe(deal('two'));
    expect(deal('one')).toBe(deal('one'));
  });

  it('asks the rng for nothing outside the shuffle', () => {
    let calls = 0;
    const counting = createRngFrom((maxExclusive) => {
      calls += 1;
      return maxExclusive - 1;
    });

    let state = tableWith(SIX);
    for (const command of HAND) state = reduce(state, command, counting).state;

    // 51 swaps for the one shuffle this hand needs, and not a draw more.
    expect(calls).toBe(51);
  });

  it('keeps Math.random, the clock and I/O out of the source', () => {
    const sourceDir = join(import.meta.dirname, '..', 'src');
    const files = readdirSync(sourceDir).filter((file) => file.endsWith('.ts'));

    expect(files.length).toBeGreaterThan(1);
    for (const file of files) {
      // Comments talk about the banned calls; only the code matters.
      const source = stripComments(readFileSync(join(sourceDir, file), 'utf8'));
      expect(source, `${file} reaches for ambient randomness`).not.toMatch(/Math\s*\.\s*random/);
      expect(source, `${file} reads the clock`).not.toMatch(/Date\s*\.\s*now|new Date\(/);
      expect(source, `${file} does I/O`).not.toMatch(/console\.|fetch\(|setTimeout|setInterval/);
      if (file !== 'rng.ts') {
        expect(source, `${file} imports a Node built-in`).not.toMatch(/from 'node:/);
      }
    }
  });
});

/** Crude but sufficient for source files this package controls. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}
