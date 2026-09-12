/**
 * CLAUDE.md rule 9 — the button advances to the next seat that was dealt in on
 * the previous hand, whether or not that seat still has a player in it.
 */
import { describe, expect, it } from 'vitest';
import { seededRng, type TableState } from '../src/index';
import { act, advance, dealHand, preflop, run, tableWith } from './helpers';

/** Fold a dealt hand around to a walk and settle it through to hand_end. */
function foldOut(state: TableState): TableState {
  let next = state;
  while (next.phase === 'preflop' && next.toActSeat !== null) {
    next = run(next, [act.fold(next.toActSeat)]);
  }
  return run(next, [advance]);
}

/** Deal a hand and fold it straight out again. */
function playFoldedHand(state: TableState, handId: string): TableState {
  return foldOut(dealHand(state, handId));
}

describe('rule 9 — moving the button', () => {
  it('starts on the lowest dealt-in seat', () => {
    expect(preflop([1000, 1000, 1000]).buttonSeat).toBe(0);
    expect(dealHand(tableWith([1000, 1000], { seatCount: 6, seats: [3, 4] })).buttonSeat).toBe(3);
  });

  it('moves one seat clockwise each hand', () => {
    const table = tableWith([1000, 1000, 1000]);
    const handTwo = dealHand(playFoldedHand(table, 'hand-1'), 'hand-2');

    expect(handTwo.buttonSeat).toBe(1);
    expect([handTwo.sbSeat, handTwo.bbSeat]).toEqual([2, 0]);

    const handThree = dealHand(foldOut(handTwo), 'hand-3');
    expect(handThree.buttonSeat).toBe(2);
    expect([handThree.sbSeat, handThree.bbSeat]).toEqual([0, 1]);
  });

  it('wraps back to the first seat', () => {
    let state = tableWith([1000, 1000, 1000]);
    for (const handId of ['hand-1', 'hand-2', 'hand-3']) {
      state = playFoldedHand(state, handId);
    }

    expect(dealHand(state, 'hand-4').buttonSeat).toBe(0);
  });

  it('records which seats were dealt in', () => {
    const state = dealHand(tableWith([1000, 1000, 1000], { seatCount: 6, seats: [1, 3, 4] }));

    expect(state.dealtInSeats).toEqual([1, 3, 4]);
    expect(state.buttonSeat).toBe(1);
    expect([state.sbSeat, state.bbSeat]).toEqual([3, 4]);
  });

  it('skips a seat that was empty last hand', () => {
    // Seats 0, 2 and 3 played hand one; a new player sits at seat 1 afterwards.
    const handOne = playFoldedHand(
      tableWith([1000, 1000, 1000], { seatCount: 4, seats: [0, 2, 3] }),
      'hand-1',
    );
    const joined = run(handOne, [{ type: 'SIT', seatIndex: 1, playerId: 'late', stack: 1000 }]);
    const handTwo = dealHand(joined, 'hand-2');

    // The button follows the previous hand's seats: 0 -> 2, not 0 -> 1.
    expect(handTwo.buttonSeat).toBe(2);
    expect([handTwo.sbSeat, handTwo.bbSeat]).toEqual([3, 0]);
    expect(handTwo.dealtInSeats).toEqual([0, 1, 2, 3]);
  });

  it('leaves the button dead on a seat whose player left', () => {
    const handOne = playFoldedHand(tableWith([1000, 1000, 1000]), 'hand-1');
    const afterLeave = run(handOne, [{ type: 'LEAVE', seatIndex: 1 }]);
    const handTwo = dealHand(afterLeave, 'hand-2');

    // Seat 1 was dealt in last hand and is next clockwise, so it takes the
    // button even though nobody is sitting there.
    expect(handTwo.buttonSeat).toBe(1);
    expect(handTwo.seats[1]).toBeNull();
    expect(handTwo.dealtInSeats).toEqual([0, 2]);
    expect([handTwo.sbSeat, handTwo.bbSeat]).toEqual([2, 0]);
    // Heads-up behind a dead button: the small blind is still first preflop.
    expect(handTwo.toActSeat).toBe(2);
  });

  it('skips a seat with no chips when handing out the blinds', () => {
    // Seat 1 posts its last 5 chips in hand one and loses the showdown.
    const handOne = run(dealHand(tableWith([1000, 5, 1000]), 'hand-1', seededRng('bust-2')), [
      act.fold(0),
      act.check(2),
      advance,
      advance,
      advance,
    ]);
    const handTwo = dealHand(handOne, 'hand-2');

    expect(handTwo.dealtInSeats).toEqual([0, 2]);
    expect(handTwo.buttonSeat).toBe(1);
    expect([handTwo.sbSeat, handTwo.bbSeat]).toEqual([2, 0]);
  });

  it('refuses to start a hand with fewer than two funded seats', () => {
    const table = tableWith([1000], { seatCount: 6 });

    expect(() => run(table, [{ type: 'START_HAND', handId: 'h' }])).toThrow(
      /at least two seats with chips/,
    );
  });
});
