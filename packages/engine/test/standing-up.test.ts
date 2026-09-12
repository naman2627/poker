import { describe, expect, it } from 'vitest';
import type { Command } from '../src/types';
import {
  act,
  advance,
  chipsInPlay,
  preflop,
  run,
  runWithEvents,
  seatAt,
  stacks,
  tableWith,
} from './helpers';

const leave = (seatIndex: number): Command => ({ type: 'LEAVE', seatIndex });

/**
 * Standing up mid-hand.
 *
 * The rule these pin down: a seat that leaves during a hand does not fold on the
 * spot. Folding out of turn would tell everyone still to act something they have
 * not paid to know, and would take a free check away from a player who had one.
 * The seat folds when the action reaches it, and the chips it already put in
 * stay where they are.
 */
describe('standing up mid-hand', () => {
  it('does not fold the hand until the action reaches the seat', () => {
    // Three-handed: seat 0 is the button, 1 the small blind, 2 the big blind,
    // and seat 0 is first to act preflop.
    const state = preflop([1000, 1000, 1000]);
    expect(state.toActSeat).toBe(0);

    // Seat 2 stands up while somebody else is on the clock.
    const { state: standing, events } = runWithEvents(state, [leave(2)]);

    expect(standing.pendingLeave).toEqual([2]);
    expect(seatAt(standing, 2).status).toBe('active');
    expect(events.map((event) => event.type)).toEqual(['PLAYER_LEAVE_PENDING']);
    // Still on seat 0's clock; nothing about the hand moved.
    expect(standing.toActSeat).toBe(0);
  });

  it('folds the seat the moment the action gets there', () => {
    const standing = run(preflop([1000, 1000, 1000]), [leave(2)]);

    const { state: after, events } = runWithEvents(standing, [act.call(0), act.call(1)]);

    expect(events).toContainEqual({
      type: 'PLAYER_ACTED',
      seatIndex: 2,
      action: 'FOLD',
      committedThisRound: 10,
      allIn: false,
    });
    expect(seatAt(after, 2).status).toBe('folded');
  });

  it('folds a seat that is already on the clock straight away', () => {
    const state = preflop([1000, 1000, 1000]);
    const { state: after, events } = runWithEvents(state, [leave(0)]);

    expect(seatAt(after, 0).status).toBe('folded');
    expect(events.map((event) => event.type)).toEqual([
      'PLAYER_LEAVE_PENDING',
      'PLAYER_ACTED',
      'ACTION_ON',
    ]);
    expect(after.toActSeat).toBe(1);
  });

  it('leaves the chips it already committed in the pot', () => {
    const state = preflop([1000, 1000, 1000]);
    const before = chipsInPlay(state);

    const after = run(state, [leave(2), act.call(0), act.call(1)]);

    // Seat 2's big blind is still in the middle, and the seat is still there to
    // hold it until the hand settles.
    expect(seatAt(after, 2).committedThisHand).toBe(10);
    expect(chipsInPlay(after)).toBe(before);
    expect(after.seats[2]).not.toBeNull();
  });

  it('empties the seat when the hand ends', () => {
    let state = run(preflop([1000, 1000, 1000]), [leave(2), act.fold(0), act.fold(1)]);
    while (state.phase !== 'hand_end') state = run(state, [advance]);

    expect(state.seats[2]).toBeNull();
    expect(state.pendingLeave).toEqual([]);
  });

  it('ends the hand when standing up leaves one player in it', () => {
    const state = preflop([1000, 1000, 1000]);

    // Seat 0 folds, then both blinds walk out. The second one to reach its turn
    // leaves nobody to play against, so the hand pays out to the last seat left.
    const after = run(state, [act.fold(0), leave(1), leave(2)]);

    expect(after.phase === 'payout' || after.phase === 'hand_end').toBe(true);
    expect(chipsInPlay(after)).toBe(3000);
  });

  it('folds a seat that stood up before the cards were dealt, and deals it none', () => {
    // Between the blinds and the deal there is no turn to wait for, and no
    // reason to give two cards to somebody who has gone.
    const state = run(tableWith([1000, 1000, 1000]), [
      { type: 'START_HAND', handId: 'h1' },
      { type: 'POST_BLINDS' },
      leave(2),
      { type: 'DEAL_HOLE' },
    ]);

    expect(seatAt(state, 2).status).toBe('folded');
    expect(seatAt(state, 2).holeCards).toEqual([]);
    expect(state.deck).toHaveLength(48);
  });

  it('never lets a departure create or destroy a chip', () => {
    let state = run(preflop([1000, 1000, 1000]), [act.raise(0, 40), leave(1), act.call(2)]);

    // Stop at the payout: one more step vacates the seat, and a stack that has
    // walked out of the door is no longer chips *in play*.
    let guard = 0;
    while (state.phase !== 'payout' && guard < 40) {
      guard += 1;
      state =
        state.toActSeat === null ? run(state, [advance]) : run(state, [act.check(state.toActSeat)]);
    }

    expect(state.phase).toBe('payout');
    expect(chipsInPlay(state)).toBe(3000);
    expect(stacks(state).every((stack) => stack === null || stack >= 0)).toBe(true);
  });
});
