/**
 * CLAUDE.md rule 5 — preflop action starts to the left of the big blind;
 * on every later street it starts to the left of the button.
 */
import { describe, expect, it } from 'vitest';
import { act, advance, dealHand, preflop, run, tableWith } from './helpers';

const SIX = [1000, 1000, 1000, 1000, 1000, 1000];

/** Everyone limps, the big blind checks, and the flop comes down. */
function toTheFlop(state = preflop(SIX)) {
  return run(state, [
    act.call(3),
    act.call(4),
    act.call(5),
    act.call(0),
    act.call(1),
    act.check(2),
    advance,
  ]);
}

describe('rule 5 — who acts first', () => {
  it('opens preflop under the gun, to the left of the big blind', () => {
    const state = preflop(SIX);

    expect([state.buttonSeat, state.sbSeat, state.bbSeat]).toEqual([0, 1, 2]);
    expect(state.toActSeat).toBe(3);
  });

  it('opens the flop to the left of the button', () => {
    const state = toTheFlop();

    expect(state.phase).toBe('flop');
    expect(state.toActSeat).toBe(1);
  });

  it('keeps that order on the turn and river', () => {
    const flop = toTheFlop();
    const turn = run(flop, [
      act.check(1),
      act.check(2),
      act.check(3),
      act.check(4),
      act.check(5),
      act.check(0),
      advance,
    ]);

    expect(turn.phase).toBe('turn');
    expect(turn.toActSeat).toBe(1);
  });

  it('skips folded seats when opening a street', () => {
    const flop = run(preflop(SIX), [
      act.call(3),
      act.call(4),
      act.call(5),
      act.call(0),
      act.fold(1),
      act.check(2),
      advance,
    ]);

    // Seat 1 folded, so the flop opens on the big blind.
    expect(flop.toActSeat).toBe(2);
  });

  it('wraps around the end of the seat list', () => {
    // Players at seats 0, 4 and 5: the button is seat 0, so preflop opens on the
    // seat to the left of the big blind at seat 5 — which is seat 0 again.
    const state = dealHand(tableWith([1000, 1000, 1000], { seatCount: 6, seats: [0, 4, 5] }));

    expect([state.buttonSeat, state.sbSeat, state.bbSeat]).toEqual([0, 4, 5]);
    expect(state.toActSeat).toBe(0);

    const flop = run(state, [act.call(0), act.call(4), act.check(5), advance]);
    expect(flop.toActSeat).toBe(4);
  });

  it('opens preflop on the button three-handed', () => {
    const state = dealHand(tableWith([1000, 1000, 1000]));

    expect([state.buttonSeat, state.sbSeat, state.bbSeat]).toEqual([0, 1, 2]);
    expect(state.toActSeat).toBe(0);
  });

  it('opens the flop on the small blind three-handed', () => {
    const flop = run(dealHand(tableWith([1000, 1000, 1000])), [
      act.call(0),
      act.call(1),
      act.check(2),
      advance,
    ]);

    expect(flop.toActSeat).toBe(1);
  });
});
