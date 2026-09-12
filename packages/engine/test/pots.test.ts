/**
 * Pots are derived from what each seat has committed, so a side pot is never
 * built by hand and can never drift away from the stacks.
 */
import { describe, expect, it } from 'vitest';
import { totalPot } from '../src/index';
import { act, advance, chipsInPlay, preflop, run, runWithEvents, stacks } from './helpers';

const SIX = [1000, 1000, 1000, 1000, 1000, 1000];

describe('pots', () => {
  it('keeps the unequal blinds in one pot while nobody is all-in', () => {
    const state = preflop(SIX);

    // Layers exist to fence off chips a short stack cannot win. Nobody is
    // all-in here, so there is nothing to fence off.
    expect(state.pots).toEqual([{ amount: 15, eligibleSeats: [1, 2] }]);
  });

  it('splits the blinds into layers once a blind is all-in for less', () => {
    const state = preflop([1000, 3, 1000]);

    expect(state.pots).toEqual([
      { amount: 6, eligibleSeats: [1, 2] },
      { amount: 7, eligibleSeats: [2] },
    ]);
  });

  it('merges into one pot once the amounts are level', () => {
    const state = run(preflop(SIX), [
      act.call(3),
      act.fold(4),
      act.fold(5),
      act.fold(0),
      act.call(1),
      act.check(2),
    ]);

    expect(state.pots).toEqual([{ amount: 30, eligibleSeats: [1, 2, 3] }]);
  });

  it('keeps a folded seat out of the pot it paid into', () => {
    const state = run(preflop(SIX), [
      act.call(3),
      act.raise(4, 60),
      act.fold(5),
      act.fold(0),
      act.fold(1),
      act.fold(2),
      act.call(3),
    ]);

    expect(state.pots).toEqual([{ amount: 135, eligibleSeats: [3, 4] }]);
    expect(totalPot(state.pots)).toBe(135);
  });

  it('builds one side pot per distinct all-in amount', () => {
    // Seat 3 has 100, seat 4 has 250, seat 5 covers both.
    const state = run(preflop([1000, 1000, 1000, 100, 250, 1000]), [
      act.allIn(3),
      act.allIn(4),
      act.allIn(5),
      act.fold(0),
      act.fold(1),
      act.fold(2),
    ]);

    expect(state.pots).toEqual([
      { amount: 315, eligibleSeats: [3, 4, 5] },
      { amount: 300, eligibleSeats: [4, 5] },
      { amount: 750, eligibleSeats: [5] },
    ]);
    expect(totalPot(state.pots)).toBe(1365);
  });

  it('pays every layer out at payout, top layer included', () => {
    const { state, events } = runWithEvents(preflop([1000, 1000, 1000, 100, 250, 1000]), [
      act.allIn(3),
      act.allIn(4),
      act.allIn(5),
      act.fold(0),
      act.fold(1),
      act.fold(2),
      advance,
      advance,
    ]);

    expect(state.phase).toBe('payout');
    expect(state.pots).toEqual([]);
    // On this deck seat 3 makes two pair and takes the main pot; seat 5's pair
    // of nines beats seat 4 for the first side pot, and the 750 nobody could
    // call comes straight back to it.
    expect(events.filter((event) => event.type === 'POT_AWARDED')).toEqual([
      { type: 'POT_AWARDED', seatIndex: 3, amount: 315, potIndex: 0 },
      { type: 'POT_AWARDED', seatIndex: 5, amount: 300, potIndex: 1 },
      { type: 'POT_AWARDED', seatIndex: 5, amount: 750, potIndex: 2 },
    ]);
    expect(stacks(state)).toEqual([1000, 995, 990, 315, 0, 1050]);
  });

  it('folds uncalled chips left by a folder down into the live layer', () => {
    // Seat 3 bets 200 into a short all-in of 40 and everyone folds behind: the
    // only live seat is seat 3 itself, so every chip is eligible to it.
    const state = run(preflop([1000, 1000, 1000, 1000, 1000, 40]), [
      act.raise(3, 200),
      act.fold(4),
      act.allIn(5),
      act.fold(0),
      act.fold(1),
      act.fold(2),
    ]);

    expect(state.phase).toBe('preflop');
    expect(totalPot(state.pots)).toBe(255);
    expect(state.pots).toEqual([
      { amount: 95, eligibleSeats: [3, 5] },
      { amount: 160, eligibleSeats: [3] },
    ]);
  });

  it('conserves every chip through a whole hand', () => {
    const dealt = preflop([1000, 1000, 1000, 100, 250, 1000]);
    expect(chipsInPlay(dealt)).toBe(4350);

    const done = run(dealt, [
      act.allIn(3),
      act.allIn(4),
      act.allIn(5),
      act.fold(0),
      act.fold(1),
      act.fold(2),
      advance,
      advance,
      advance,
    ]);

    expect(done.phase).toBe('hand_end');
    expect(chipsInPlay(done)).toBe(4350);
  });
});
