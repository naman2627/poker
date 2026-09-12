/**
 * CLAUDE.md rule 6 — blinds come out of the stack, and can put a player all-in
 * for less than the blind.
 */
import { describe, expect, it } from 'vitest';
import { legalActions, seededRng, totalPot } from '../src/index';
import { act, dealHand, preflop, run, runWithEvents, seatAt, tableWith } from './helpers';

const SIX = [1000, 1000, 1000, 1000, 1000, 1000];

describe('rule 6 — posting the blinds', () => {
  it('takes the blinds out of the stacks and into the pot', () => {
    const state = preflop(SIX);

    expect(seatAt(state, 1).stack).toBe(995);
    expect(seatAt(state, 1).committedThisRound).toBe(5);
    expect(seatAt(state, 2).stack).toBe(990);
    expect(seatAt(state, 2).committedThisHand).toBe(10);
    expect(totalPot(state.pots)).toBe(15);
  });

  it('reports each blind as it is posted', () => {
    const { events } = runWithEvents(tableWith(SIX), [
      { type: 'START_HAND', handId: 'h' },
      { type: 'POST_BLINDS' },
    ]);

    expect(events.filter((event) => event.type === 'BLIND_POSTED')).toEqual([
      { type: 'BLIND_POSTED', seatIndex: 1, blind: 'small', amount: 5, allIn: false },
      { type: 'BLIND_POSTED', seatIndex: 2, blind: 'big', amount: 10, allIn: false },
    ]);
  });

  it('puts a short small blind all-in for less', () => {
    const state = preflop([1000, 3, 1000]);

    expect(seatAt(state, 1).stack).toBe(0);
    expect(seatAt(state, 1).status).toBe('allin');
    expect(seatAt(state, 1).committedThisHand).toBe(3);
    expect(totalPot(state.pots)).toBe(13);
  });

  it('puts a short big blind all-in for less and still asks a full blind to call', () => {
    const state = preflop([1000, 1000, 4]);

    expect(seatAt(state, 2).status).toBe('allin');
    expect(seatAt(state, 2).committedThisHand).toBe(4);
    expect(state.currentBet).toBe(10);
    expect(legalActions(state, 0)).toMatchObject({ callAmount: 10, minRaiseTo: 20 });
  });

  it('does not put an all-in blind on the clock or give it an option', () => {
    const state = run(preflop([1000, 1000, 4]), [act.call(0), act.call(1)]);

    expect(seatAt(state, 2).status).toBe('allin');
    expect(state.toActSeat).toBeNull();
    expect(state.phase).toBe('preflop');
  });

  it('leaves the blinds owing an action: posting is not acting', () => {
    const state = preflop(SIX);

    expect(seatAt(state, 1).hasActedThisRound).toBe(false);
    expect(seatAt(state, 2).hasActedThisRound).toBe(false);
  });

  it('opens the betting at the big blind with the big blind as the last raiser', () => {
    const state = preflop(SIX);

    expect(state.currentBet).toBe(10);
    expect(state.minRaise).toBe(10);
    expect(state.lastAggressorSeat).toBe(2);
  });

  it('refuses to post the blinds twice', () => {
    const posted = run(tableWith(SIX), [
      { type: 'START_HAND', handId: 'h' },
      { type: 'POST_BLINDS' },
    ]);

    expect(() => run(posted, [{ type: 'POST_BLINDS' }])).toThrow(/already been posted/);
  });

  it('refuses to deal before the blinds are posted', () => {
    const started = run(tableWith(SIX), [{ type: 'START_HAND', handId: 'h' }]);

    expect(() => run(started, [{ type: 'DEAL_HOLE' }])).toThrow(/blinds must be posted/);
  });

  it('leaves a busted stack out of the next hand instead of dealing it in', () => {
    // Seat 1 posts its last 3 chips, is all-in, and loses the showdown on this
    // deck — so it comes out of the hand with nothing.
    const handOne = run(dealHand(tableWith([1000, 3, 1000]), 'hand-1', seededRng('bust-2')), [
      act.fold(0),
      act.check(2),
      { type: 'ADVANCE_STREET' },
      { type: 'ADVANCE_STREET' },
      { type: 'ADVANCE_STREET' },
    ]);
    expect(handOne.phase).toBe('hand_end');
    expect(seatAt(handOne, 1).stack).toBe(0);

    const handTwo = dealHand(handOne, 'hand-2');
    expect(handTwo.dealtInSeats).toEqual([0, 2]);
    expect(seatAt(handTwo, 1).status).toBe('sitting_out');
    expect(seatAt(handTwo, 1).holeCards).toEqual([]);
  });
});
