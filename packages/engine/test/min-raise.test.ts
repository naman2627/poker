/**
 * CLAUDE.md rule 2 — minRaise starts at the big blind and then equals the size
 * of the last full raise; a raise must be to at least currentBet + minRaise.
 */
import { describe, expect, it } from 'vitest';
import { legalActions } from '../src/index';
import { act, advance, preflop, run, seatAt } from './helpers';

const SIX = [1000, 1000, 1000, 1000, 1000, 1000];

describe('rule 2 — the size of a raise', () => {
  it('starts at the big blind once the blinds are posted', () => {
    const state = preflop(SIX);

    expect(state.currentBet).toBe(10);
    expect(state.minRaise).toBe(10);
    expect(legalActions(state, 3).minRaiseTo).toBe(20);
  });

  it('refuses a raise below currentBet + minRaise', () => {
    const state = preflop(SIX);

    expect(() => run(state, [act.raise(3, 19)])).toThrow(/outside the legal range \[20, 1000\]/);
  });

  it('accepts a raise to exactly the minimum', () => {
    const state = run(preflop(SIX), [act.raise(3, 20)]);

    expect(state.currentBet).toBe(20);
    expect(state.minRaise).toBe(10);
    expect(seatAt(state, 3).stack).toBe(980);
  });

  it('remembers the size of the last full raise, not the last bet', () => {
    const state = run(preflop(SIX), [act.raise(3, 30)]);

    expect(state.minRaise).toBe(20);
    expect(legalActions(state, 4).minRaiseTo).toBe(50);
  });

  it('refuses a re-raise that is short of the last full raise', () => {
    const state = run(preflop(SIX), [act.raise(3, 30)]);

    expect(() => run(state, [act.raise(4, 45)])).toThrow(/outside the legal range \[50, 1000\]/);
  });

  it('tracks a re-raise of exactly the minimum', () => {
    const state = run(preflop(SIX), [act.raise(3, 30), act.raise(4, 50)]);

    expect(state.currentBet).toBe(50);
    expect(state.minRaise).toBe(20);
    expect(legalActions(state, 5).minRaiseTo).toBe(70);
  });

  it('grows minRaise when someone raises by more than the minimum', () => {
    const state = run(preflop(SIX), [act.raise(3, 30), act.raise(4, 120)]);

    expect(state.minRaise).toBe(90);
    expect(legalActions(state, 5).minRaiseTo).toBe(210);
  });

  it('resets to the big blind on every new street', () => {
    const flop = run(preflop(SIX), [
      act.raise(3, 120),
      act.fold(4),
      act.fold(5),
      act.fold(0),
      act.fold(1),
      act.call(2),
      advance,
    ]);

    expect(flop.phase).toBe('flop');
    expect(flop.currentBet).toBe(0);
    expect(flop.minRaise).toBe(10);
    expect(legalActions(flop, 2)).toMatchObject({ canBet: true, minRaiseTo: 10, maxRaiseTo: 880 });
  });

  it('refuses a postflop bet smaller than the big blind', () => {
    const flop = run(preflop(SIX), [
      act.raise(3, 120),
      act.fold(4),
      act.fold(5),
      act.fold(0),
      act.fold(1),
      act.call(2),
      advance,
    ]);

    expect(() => run(flop, [act.bet(2, 9)])).toThrow(/outside the legal range \[10, 880\]/);
    expect(run(flop, [act.bet(2, 10)]).currentBet).toBe(10);
  });

  it('caps a raise at the stack behind it', () => {
    const state = preflop([1000, 1000, 1000, 90, 1000, 1000]);

    expect(legalActions(state, 3)).toMatchObject({ minRaiseTo: 20, maxRaiseTo: 90 });
    expect(() => run(state, [act.raise(3, 91)])).toThrow(/outside the legal range \[20, 90\]/);
  });

  it('counts chips already in front of a seat toward its raise total', () => {
    // The small blind has 5 out already, so raising "to 200" costs it 195.
    const state = run(preflop(SIX), [
      act.fold(3),
      act.fold(4),
      act.fold(5),
      act.fold(0),
      act.raise(1, 200),
    ]);

    expect(seatAt(state, 1).stack).toBe(800);
    expect(seatAt(state, 1).committedThisRound).toBe(200);
    expect(state.currentBet).toBe(200);
    expect(state.minRaise).toBe(190);
  });

  it('rejects a fractional amount', () => {
    const state = preflop(SIX);

    expect(() => run(state, [act.raise(3, 20.5)])).toThrow(/chips are whole/);
  });
});
