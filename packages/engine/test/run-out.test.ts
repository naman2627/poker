/**
 * CLAUDE.md rule 8 — if two or more players remain but at most one of them can
 * still act, run out the remaining board with no betting and go to showdown.
 */
import { describe, expect, it } from 'vitest';
import { legalActions, totalPot } from '../src/index';
import { act, advance, preflop, run, runWithEvents, seatAt } from './helpers';

describe('rule 8 — running out the board', () => {
  it('deals flop, turn and river in one step after an all-in call', () => {
    const { state, events } = runWithEvents(preflop([200, 1000]), [
      act.allIn(0),
      act.call(1),
      advance,
    ]);

    expect(state.phase).toBe('showdown');
    expect(state.board).toHaveLength(5);
    expect(state.toActSeat).toBeNull();
    expect(
      events.filter((event) => event.type === 'BOARD_DEALT').map((event) => event.phase),
    ).toEqual(['flop', 'turn', 'river']);
  });

  it('opens no betting round on the way through', () => {
    const state = run(preflop([200, 1000]), [act.allIn(0), act.call(1), advance]);

    expect(state.toActSeat).toBeNull();
    expect(legalActions(state, 0)).toMatchObject({ canBet: false, canCall: false, canFold: false });
    expect(legalActions(state, 1)).toMatchObject({ canBet: false, canCall: false, canFold: false });
    expect(() => run(state, [act.bet(1, 50)])).toThrow(/no betting is open in phase showdown/);
  });

  it('leaves the pot standing for the showdown', () => {
    const state = run(preflop([200, 1000]), [act.allIn(0), act.call(1), advance]);

    expect(state.pots).toEqual([{ amount: 400, eligibleSeats: [0, 1] }]);
  });

  it('announces the seats that reached the showdown', () => {
    const { events } = runWithEvents(preflop([200, 1000]), [act.allIn(0), act.call(1), advance]);

    expect(events).toContainEqual({ type: 'SHOWDOWN_REACHED', seats: [0, 1] });
  });

  it('runs out only what is left when the all-in comes on the flop', () => {
    const flop = run(preflop([1000, 300]), [act.call(0), act.check(1), advance]);
    const state = run(flop, [act.allIn(1), act.call(0), advance]);

    expect(state.phase).toBe('showdown');
    expect(state.board).toHaveLength(5);
    expect(seatAt(state, 1).status).toBe('allin');
  });

  it('keeps betting alive when two players still have chips behind', () => {
    // Seat 5 is all-in preflop, but seats 0 and 2 can still play for a side pot.
    const state = run(preflop([1000, 1000, 1000, 1000, 1000, 60]), [
      act.fold(3),
      act.fold(4),
      act.allIn(5),
      act.call(0),
      act.fold(1),
      act.call(2),
      advance,
    ]);

    expect(state.phase).toBe('flop');
    expect(state.board).toHaveLength(3);
    expect(state.toActSeat).toBe(2);
  });

  it('builds the side pot before the run-out', () => {
    const state = run(preflop([1000, 1000, 1000, 1000, 1000, 60]), [
      act.fold(3),
      act.fold(4),
      act.allIn(5),
      act.raise(0, 200),
      act.fold(1),
      act.fold(2),
      advance,
    ]);

    expect(state.phase).toBe('showdown');
    expect(state.pots).toEqual([
      { amount: 135, eligibleSeats: [0, 5] },
      // Seat 0's uncalled excess over the short all-in comes straight back.
      { amount: 140, eligibleSeats: [0] },
    ]);
  });

  it('pays back the uncalled remainder at payout', () => {
    const { state, events } = runWithEvents(preflop([1000, 1000, 1000, 1000, 1000, 60]), [
      act.fold(3),
      act.fold(4),
      act.allIn(5),
      act.raise(0, 200),
      act.fold(1),
      act.fold(2),
      advance,
      advance,
    ]);

    expect(state.phase).toBe('payout');
    // The 140 nobody could call goes back to seat 0 whatever happens; the 135
    // main pot goes to seat 5's pair of nines on this deck.
    expect(events.filter((event) => event.type === 'POT_AWARDED')).toEqual([
      { type: 'POT_AWARDED', seatIndex: 5, amount: 135, potIndex: 0 },
      { type: 'POT_AWARDED', seatIndex: 0, amount: 140, potIndex: 1 },
    ]);
    expect(seatAt(state, 0).stack).toBe(940);
    expect(totalPot(state.pots)).toBe(0);
  });

  it('runs out when everyone is all-in with nobody left to act', () => {
    const state = run(preflop([200, 200]), [act.allIn(0), act.call(1), advance]);

    expect(state.phase).toBe('showdown');
    expect(seatAt(state, 0).status).toBe('allin');
    expect(seatAt(state, 1).status).toBe('allin');
    expect(state.board).toHaveLength(5);
  });
});
