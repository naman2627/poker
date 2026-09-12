/**
 * CLAUDE.md rule 1 — a betting round ends only when every seat with status
 * 'active' has acted since the last aggression AND has matched the current bet.
 * Any bet or raise clears hasActedThisRound for the other active seats.
 */
import { describe, expect, it } from 'vitest';
import { EngineError, isBettingRoundComplete, legalActions } from '../src/index';
import { act, advance, preflop, run, runWithEvents, seatAt } from './helpers';

const SIX = [1000, 1000, 1000, 1000, 1000, 1000];

describe('rule 1 — closing a betting round', () => {
  it('does not close on the last limper: the big blind still has an option', () => {
    // Button 0, small blind 1, big blind 2, so the limps run 3, 4, 5, 0, 1.
    const state = run(preflop(SIX), [
      act.call(3),
      act.call(4),
      act.call(5),
      act.call(0),
      act.call(1),
    ]);

    expect(state.toActSeat).toBe(2);
    expect(isBettingRoundComplete(state)).toBe(false);
    expect(seatAt(state, 2).hasActedThisRound).toBe(false);
  });

  it('lets the big blind raise their option rather than only check', () => {
    const state = run(preflop(SIX), [
      act.call(3),
      act.call(4),
      act.call(5),
      act.call(0),
      act.call(1),
    ]);

    expect(legalActions(state, 2)).toMatchObject({
      canCheck: true,
      canRaise: true,
      minRaiseTo: 20,
    });
  });

  it('closes once the big blind takes their option', () => {
    const { state, events } = runWithEvents(preflop(SIX), [
      act.call(3),
      act.call(4),
      act.call(5),
      act.call(0),
      act.call(1),
      act.check(2),
    ]);

    expect(state.toActSeat).toBeNull();
    expect(isBettingRoundComplete(state)).toBe(true);
    expect(events.at(-1)).toEqual({ type: 'BETTING_ROUND_ENDED', phase: 'preflop' });
  });

  it('a raise clears hasActedThisRound for every other active seat', () => {
    const state = run(preflop(SIX), [act.call(3), act.raise(4, 30)]);

    expect(seatAt(state, 3).hasActedThisRound).toBe(false);
    expect(seatAt(state, 4).hasActedThisRound).toBe(true);
    for (const seatIndex of [5, 0, 1, 2]) {
      expect(seatAt(state, seatIndex).hasActedThisRound).toBe(false);
    }
  });

  it('a call does not reopen the action for anyone', () => {
    const state = run(preflop(SIX), [act.call(3), act.call(4)]);

    expect(seatAt(state, 3).hasActedThisRound).toBe(true);
    expect(seatAt(state, 4).hasActedThisRound).toBe(true);
  });

  it('brings the action back around to a seat that has already called', () => {
    const state = run(preflop(SIX), [
      act.call(3),
      act.raise(4, 30),
      act.fold(5),
      act.fold(0),
      act.fold(1),
      act.fold(2),
    ]);

    expect(state.toActSeat).toBe(3);
    expect(legalActions(state, 3)).toMatchObject({ canCall: true, callAmount: 20, canRaise: true });
  });

  it('does not wait for seats that folded', () => {
    const state = run(preflop(SIX), [
      act.fold(3),
      act.fold(4),
      act.fold(5),
      act.call(0),
      act.call(1),
      act.check(2),
    ]);

    expect(isBettingRoundComplete(state)).toBe(true);
    expect(state.toActSeat).toBeNull();
  });

  it('closes a postflop round after everyone checks', () => {
    const preflopDone = run(preflop(SIX), [
      act.fold(3),
      act.fold(4),
      act.fold(5),
      act.call(0),
      act.call(1),
      act.check(2),
      advance,
    ]);
    const state = run(preflopDone, [act.check(1), act.check(2), act.check(0)]);

    expect(state.phase).toBe('flop');
    expect(state.toActSeat).toBeNull();
    expect(isBettingRoundComplete(state)).toBe(true);
  });

  it('reopens a postflop round when someone bets behind the checks', () => {
    const flop = run(preflop(SIX), [
      act.fold(3),
      act.fold(4),
      act.fold(5),
      act.call(0),
      act.call(1),
      act.check(2),
      advance,
    ]);
    const state = run(flop, [act.check(1), act.check(2), act.bet(0, 40)]);

    expect(state.toActSeat).toBe(1);
    expect(seatAt(state, 1).hasActedThisRound).toBe(false);
    expect(seatAt(state, 2).hasActedThisRound).toBe(false);
    expect(isBettingRoundComplete(state)).toBe(false);
  });

  it('refuses to advance the street while a seat still owes an action', () => {
    const state = run(preflop(SIX), [act.call(3)]);

    expect(() => run(state, [advance])).toThrow(EngineError);
    expect(() => run(state, [advance])).toThrow(/still has to act/);
  });

  it('refuses an action from a seat that is not on the clock', () => {
    const state = preflop(SIX);

    expect(() => run(state, [act.call(4)])).toThrow(/it is seat 3's turn/);
  });
});
