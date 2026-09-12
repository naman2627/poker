import { describe, expect, it } from 'vitest';
import { reduce } from '../src/reduce';
import { seededRng } from '../src/rng';
import type { Command, TableState } from '../src/types';
import { act, advance, dealHand, preflop, run, seatAt, statuses, tableWith } from './helpers';

function send(state: TableState, ...commands: Command[]): TableState {
  return run(state, commands);
}

const sitOut = (seatIndex: number, sittingOut: boolean): Command => ({
  type: 'SET_SITTING_OUT',
  seatIndex,
  sittingOut,
});

/** Fold the hand out, whoever is on the clock, until it settles. */
function foldToTheEnd(state: TableState): TableState {
  let next = state;
  let guard = 0;

  while (next.phase !== 'hand_end' && guard < 40) {
    guard += 1;
    next = next.toActSeat === null ? run(next, [advance]) : run(next, [act.fold(next.toActSeat)]);
  }
  return next;
}

describe('sitting out', () => {
  it('keeps a seat out of the next hand', () => {
    const out = send(tableWith([1000, 1000, 1000]), sitOut(2, true));

    expect(seatAt(out, 2).sittingOut).toBe(true);
    expect(seatAt(out, 2).status).toBe('sitting_out');

    const dealt = dealHand(out, 'h1');
    expect(dealt.dealtInSeats).toEqual([0, 1]);
    expect(seatAt(dealt, 2).holeCards).toEqual([]);
    expect(statuses(dealt)).toEqual(['active', 'active', 'sitting_out']);
  });

  it('is sticky: one request keeps a seat out of every hand after it', () => {
    let state = send(tableWith([1000, 1000, 1000]), sitOut(2, true));

    for (const handId of ['h1', 'h2', 'h3']) {
      state = foldToTheEnd(dealHand(state, handId));
      expect(state.dealtInSeats).not.toContain(2);
    }

    expect(seatAt(state, 2).sittingOut).toBe(true);
    expect(state.handNumber).toBe(3);
  });

  it('deals a seat back in once it asks', () => {
    const back = send(tableWith([1000, 1000, 1000]), sitOut(2, true), sitOut(2, false));

    expect(seatAt(back, 2).sittingOut).toBe(false);
    expect(seatAt(back, 2).status).toBe('active');
    expect(dealHand(back, 'h1').dealtInSeats).toEqual([0, 1, 2]);
  });

  it('changes nothing about the hand it is asked during', () => {
    const state = preflop([1000, 1000, 1000]);
    const out = send(state, sitOut(0, true));

    // Still holding cards, still in the hand, still on the same clock: asking to
    // sit out is a request about the *next* hand, not a way out of this one.
    expect(seatAt(out, 0).status).toBe('active');
    expect(seatAt(out, 0).holeCards).toHaveLength(2);
    expect(out.toActSeat).toBe(state.toActSeat);
    expect(seatAt(out, 0).sittingOut).toBe(true);
  });

  it('takes effect from the hand after the one it was asked during', () => {
    const played = foldToTheEnd(send(preflop([1000, 1000, 1000]), sitOut(0, true)));
    expect(dealHand(played, 'h2').dealtInSeats).not.toContain(0);
  });

  it('says nothing when asked for the state a seat is already in', () => {
    const { events } = reduce(tableWith([1000, 1000]), sitOut(0, false), seededRng('quiet'));
    expect(events).toEqual([]);
  });

  it('still deals a hand when only two of three seats are in', () => {
    const out = send(tableWith([1000, 1000, 1000]), sitOut(1, true));
    expect(dealHand(out, 'h1').dealtInSeats).toEqual([0, 2]);
  });

  it('refuses to start a hand when sitting out leaves fewer than two', () => {
    const out = send(tableWith([1000, 1000, 1000]), sitOut(1, true), sitOut(2, true));
    expect(() => dealHand(out, 'h1')).toThrow(/at least two seats with chips/);
  });
});

describe('rebuying', () => {
  it('adds chips between hands and leaves the seat in for the next one', () => {
    const table = tableWith([1000, 1000, 1000]);
    const rebought = send(table, { type: 'REBUY', seatIndex: 2, amount: 500 });

    expect(seatAt(rebought, 2).stack).toBe(1500);
    expect(seatAt(rebought, 2).sittingOut).toBe(false);
    expect(dealHand(rebought, 'h1').dealtInSeats).toEqual([0, 1, 2]);
  });

  it('refuses a rebuy from a seat that is still in a hand', () => {
    const state = preflop([1000, 1000, 1000]);
    expect(() => send(state, { type: 'REBUY', seatIndex: 0, amount: 500 })).toThrow(
      /cannot rebuy in the middle of a hand/,
    );
  });

  it('lets a seat that was dealt out rebuy while the others play', () => {
    const dealt = dealHand(send(tableWith([1000, 1000, 1000]), sitOut(2, true)), 'h1');

    expect(seatAt(dealt, 2).status).toBe('sitting_out');
    expect(seatAt(send(dealt, { type: 'REBUY', seatIndex: 2, amount: 250 }), 2).stack).toBe(1250);
  });
});
