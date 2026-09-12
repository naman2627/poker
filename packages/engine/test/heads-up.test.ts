/**
 * CLAUDE.md rule 4 — heads-up, the button is the small blind, acts first
 * preflop and last on every other street.
 */
import { describe, expect, it } from 'vitest';
import { legalActions } from '../src/index';
import { act, advance, dealHand, preflop, run, tableWith } from './helpers';

const HU = [1000, 1000];

describe('rule 4 — heads-up', () => {
  it('puts the small blind on the button', () => {
    const state = preflop(HU);

    expect(state.buttonSeat).toBe(0);
    expect(state.sbSeat).toBe(0);
    expect(state.bbSeat).toBe(1);
  });

  it('gives the button the first move preflop', () => {
    const state = preflop(HU);

    expect(state.toActSeat).toBe(0);
    expect(legalActions(state, 0)).toMatchObject({ canCall: true, callAmount: 5, canCheck: false });
  });

  it('gives the big blind the last word preflop', () => {
    const state = run(preflop(HU), [act.call(0)]);

    expect(state.toActSeat).toBe(1);
    expect(legalActions(state, 1)).toMatchObject({ canCheck: true, canRaise: true });
  });

  it('gives the big blind the first move on the flop', () => {
    const state = run(preflop(HU), [act.call(0), act.check(1), advance]);

    expect(state.phase).toBe('flop');
    expect(state.toActSeat).toBe(1);
  });

  it('gives the button the last word on the flop', () => {
    const state = run(preflop(HU), [act.call(0), act.check(1), advance, act.bet(1, 40)]);

    expect(state.toActSeat).toBe(0);
  });

  it('keeps that order on the turn and the river', () => {
    const turn = run(preflop(HU), [
      act.call(0),
      act.check(1),
      advance,
      act.check(1),
      act.check(0),
      advance,
    ]);
    expect(turn.phase).toBe('turn');
    expect(turn.toActSeat).toBe(1);

    const river = run(turn, [act.check(1), act.check(0), advance]);
    expect(river.phase).toBe('river');
    expect(river.toActSeat).toBe(1);
  });

  it('passes the button to the other seat next hand', () => {
    const handOne = run(preflop(HU), [act.fold(0), advance]);
    expect(handOne.phase).toBe('hand_end');

    const handTwo = dealHand(handOne, 'hand-2');
    expect(handTwo.buttonSeat).toBe(1);
    expect(handTwo.sbSeat).toBe(1);
    expect(handTwo.bbSeat).toBe(0);
    expect(handTwo.toActSeat).toBe(1);
  });

  it('works with the two seats far apart at a six-max table', () => {
    const state = dealHand(tableWith(HU, { seatCount: 6, seats: [2, 5] }));

    expect(state.buttonSeat).toBe(2);
    expect(state.sbSeat).toBe(2);
    expect(state.bbSeat).toBe(5);
    expect(state.toActSeat).toBe(2);

    const flop = run(state, [act.call(2), act.check(5), advance]);
    expect(flop.toActSeat).toBe(5);
  });
});
