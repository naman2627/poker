/**
 * legalActions() is the only place that decides what a seat may do, and
 * reduce() validates every action against it. A client may propose; the server
 * decides (CLAUDE.md rule 4).
 */
import { describe, expect, it } from 'vitest';
import { legalActions } from '../src/index';
import { act, advance, dealHand, preflop, run, tableWith } from './helpers';

const SIX = [1000, 1000, 1000, 1000, 1000, 1000];

const NOTHING = {
  canFold: false,
  canCheck: false,
  canCall: false,
  callAmount: 0,
  canBet: false,
  canRaise: false,
  minRaiseTo: 0,
  maxRaiseTo: 0,
};

describe('legalActions', () => {
  it('offers nothing to a seat that is not on the clock', () => {
    const state = preflop(SIX);

    expect(state.toActSeat).toBe(3);
    expect(legalActions(state, 4)).toEqual(NOTHING);
    expect(legalActions(state, 2)).toEqual(NOTHING);
  });

  it('offers nothing for an empty seat or one off the table', () => {
    const state = preflop([1000, 1000], { seatCount: 6 });

    expect(legalActions(state, 5)).toEqual(NOTHING);
    expect(legalActions(state, 99)).toEqual(NOTHING);
  });

  it('offers nothing outside a betting street', () => {
    const beforeTheDeal = run(tableWith(SIX), [
      { type: 'START_HAND', handId: 'h' },
      { type: 'POST_BLINDS' },
    ]);

    expect(beforeTheDeal.phase).toBe('hand_start');
    expect(legalActions(beforeTheDeal, 3)).toEqual(NOTHING);
  });

  it('describes a seat facing the big blind', () => {
    expect(legalActions(preflop(SIX), 3)).toEqual({
      canFold: true,
      canCheck: false,
      canCall: true,
      callAmount: 10,
      canBet: false,
      canRaise: true,
      minRaiseTo: 20,
      maxRaiseTo: 1000,
    });
  });

  it('describes a seat with no bet in front of it', () => {
    const flop = run(preflop(SIX), [
      act.fold(3),
      act.fold(4),
      act.fold(5),
      act.fold(0),
      act.call(1),
      act.check(2),
      advance,
    ]);

    expect(legalActions(flop, 1)).toEqual({
      canFold: true,
      canCheck: true,
      canCall: false,
      callAmount: 0,
      canBet: true,
      canRaise: false,
      minRaiseTo: 10,
      maxRaiseTo: 990,
    });
  });

  it('lets a seat fold even when checking is free', () => {
    const flop = run(preflop(SIX), [
      act.fold(3),
      act.fold(4),
      act.fold(5),
      act.fold(0),
      act.call(1),
      act.check(2),
      advance,
    ]);

    expect(legalActions(flop, 1).canFold).toBe(true);
    expect(run(flop, [act.fold(1)]).phase).toBe('payout');
  });

  it('caps a call at the stack, which makes it an all-in call', () => {
    const state = run(preflop([1000, 1000, 1000, 1000, 1000, 40]), [
      act.raise(3, 300),
      act.fold(4),
    ]);

    expect(legalActions(state, 5)).toMatchObject({
      canCall: true,
      callAmount: 40,
      canRaise: false,
      maxRaiseTo: 0,
    });
  });

  it('still offers a shove to a stack shorter than the minimum raise', () => {
    const state = run(preflop([1000, 1000, 1000, 1000, 1000, 25]), [act.raise(3, 20)]);

    // Seat 4 folds so seat 5 faces 20 with 25 behind: it can only shove to 25.
    const facing = run(state, [act.fold(4)]);
    expect(legalActions(facing, 5)).toMatchObject({
      canCall: true,
      callAmount: 20,
      canRaise: true,
      minRaiseTo: 25,
      maxRaiseTo: 25,
    });
  });

  it('counts chips already committed toward the raise ceiling', () => {
    const state = run(preflop(SIX), [act.fold(3), act.fold(4), act.fold(5), act.fold(0)]);

    // The small blind has 5 in front of it and 995 behind: it can raise to 1000.
    expect(legalActions(state, 1)).toMatchObject({ callAmount: 5, maxRaiseTo: 1000 });
  });

  it('refuses a check when there is a bet to call', () => {
    expect(() => run(preflop(SIX), [act.check(3)])).toThrow(/cannot check facing a bet/);
  });

  it('refuses a call when there is nothing to call', () => {
    const flop = run(preflop(SIX), [
      act.fold(3),
      act.fold(4),
      act.fold(5),
      act.fold(0),
      act.call(1),
      act.check(2),
      advance,
    ]);

    expect(() => run(flop, [act.call(1)])).toThrow(/has nothing to call/);
  });

  it('refuses a bet when someone has already bet', () => {
    expect(() => run(preflop(SIX), [act.bet(3, 40)])).toThrow(/cannot bet facing a bet/);
  });

  it('refuses an action from an empty seat', () => {
    const state = dealHand(tableWith([1000, 1000, 1000], { seatCount: 6 }));

    expect(() => run(state, [act.fold(5)])).toThrow(/turn/);
  });
});
