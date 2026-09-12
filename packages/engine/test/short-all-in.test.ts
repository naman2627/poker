/**
 * CLAUDE.md rule 3 — an all-in for less than a full raise does not reopen the
 * betting for players who already matched the current bet; they may only call or
 * fold. It does reopen for anyone who has not acted since.
 */
import { describe, expect, it } from 'vitest';
import { legalActions } from '../src/index';
import { act, preflop, run, seatAt } from './helpers';

/** Seat 5 is short: 55 chips, enough to raise but not by a full raise. */
const SHORT_FIFTH = [1000, 1000, 1000, 1000, 1000, 55];
/** Seat 5 has 100: over the line, so its shove is a full raise. */
const BIG_FIFTH = [1000, 1000, 1000, 1000, 1000, 100];

/** Seat 3 opens to 40 (a full raise of 30), seat 4 calls, seat 5 shoves. */
function toTheShove(stacks: readonly number[]) {
  return run(preflop(stacks), [act.raise(3, 40), act.call(4), act.allIn(5)]);
}

describe('rule 3 — an under-sized all-in', () => {
  it('still raises the amount everyone has to call', () => {
    const state = toTheShove(SHORT_FIFTH);

    expect(state.currentBet).toBe(55);
    expect(seatAt(state, 5).status).toBe('allin');
    expect(seatAt(state, 5).stack).toBe(0);
  });

  it('does not become the new minimum raise', () => {
    const state = toTheShove(SHORT_FIFTH);

    // The last full raise was seat 3's, from 10 to 40.
    expect(state.minRaise).toBe(30);
  });

  it('leaves a seat that already matched able only to call or fold', () => {
    const state = run(toTheShove(SHORT_FIFTH), [act.fold(0), act.fold(1), act.fold(2)]);

    expect(state.toActSeat).toBe(3);
    expect(legalActions(state, 3)).toEqual({
      canFold: true,
      canCheck: false,
      canCall: true,
      callAmount: 15,
      canBet: false,
      canRaise: false,
      minRaiseTo: 0,
      maxRaiseTo: 0,
    });
  });

  it('refuses a shove from a seat the action is closed to', () => {
    const state = run(toTheShove(SHORT_FIFTH), [act.fold(0), act.fold(1), act.fold(2)]);

    // Seat 3 has 960 behind, but the short all-in did not reopen the betting.
    expect(() => run(state, [act.allIn(3)])).toThrow(/may only call or fold here/);
  });

  it('still lets a seat shove when the all-in was a full raise', () => {
    const state = run(toTheShove(BIG_FIFTH), [act.fold(0), act.fold(1), act.fold(2)]);

    expect(run(state, [act.allIn(3)]).currentBet).toBe(1000);
  });

  it('refuses a raise from a seat the action is closed to', () => {
    const state = run(toTheShove(SHORT_FIFTH), [act.fold(0), act.fold(1), act.fold(2)]);

    expect(() => run(state, [act.raise(3, 200)])).toThrow(/seat 3 cannot raise here/);
  });

  it('does reopen the betting for a seat that has not acted since', () => {
    const state = toTheShove(SHORT_FIFTH);

    expect(state.toActSeat).toBe(0);
    expect(legalActions(state, 0)).toMatchObject({
      canRaise: true,
      // currentBet 55 plus the last full raise of 30.
      minRaiseTo: 85,
      maxRaiseTo: 1000,
      callAmount: 55,
    });
  });

  it('still makes the matched seats respond to the extra chips', () => {
    const state = run(toTheShove(SHORT_FIFTH), [act.call(0), act.fold(1), act.fold(2)]);

    expect(state.toActSeat).toBe(3);
    expect(seatAt(state, 3).hasActedThisRound).toBe(true);
    expect(seatAt(state, 3).committedThisRound).toBe(40);
  });

  it('closes the round once they have called', () => {
    const state = run(toTheShove(SHORT_FIFTH), [
      act.fold(0),
      act.fold(1),
      act.fold(2),
      act.call(3),
      act.call(4),
    ]);

    expect(state.toActSeat).toBeNull();
    expect(state.currentBet).toBe(55);
  });

  it('reopens for everyone when the all-in is a full raise', () => {
    const state = toTheShove(BIG_FIFTH);

    expect(state.currentBet).toBe(100);
    expect(state.minRaise).toBe(60);
    expect(seatAt(state, 3).hasActedThisRound).toBe(false);
    expect(seatAt(state, 4).hasActedThisRound).toBe(false);
  });

  it('lets a seat that already called re-raise after a full all-in', () => {
    const state = run(toTheShove(BIG_FIFTH), [act.fold(0), act.fold(1), act.fold(2)]);

    expect(legalActions(state, 3)).toMatchObject({
      canCall: true,
      callAmount: 60,
      canRaise: true,
      minRaiseTo: 160,
    });
  });

  it('treats a shove short of the current bet as a call, not a raise', () => {
    // Seat 5 has 25 and faces 40: it cannot raise anything.
    const state = run(preflop([1000, 1000, 1000, 1000, 1000, 25]), [
      act.raise(3, 40),
      act.call(4),
      act.allIn(5),
    ]);

    expect(state.currentBet).toBe(40);
    expect(state.minRaise).toBe(30);
    expect(seatAt(state, 3).hasActedThisRound).toBe(true);
    expect(seatAt(state, 5).committedThisHand).toBe(25);
  });
});
