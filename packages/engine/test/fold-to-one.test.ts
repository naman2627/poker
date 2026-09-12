/**
 * CLAUDE.md rule 7 — if only one non-folded player remains, jump straight to
 * payout without dealing more streets.
 */
import { describe, expect, it } from 'vitest';
import { totalPot } from '../src/index';
import { act, advance, chipsInPlay, preflop, run, runWithEvents, seatAt, stacks } from './helpers';

const SIX = [1000, 1000, 1000, 1000, 1000, 1000];

/** Everyone folds around to the big blind: a walk. */
const WALK = [act.fold(3), act.fold(4), act.fold(5), act.fold(0), act.fold(1)];

describe('rule 7 — everyone else folded', () => {
  it('goes straight to payout, skipping the showdown', () => {
    const state = run(preflop(SIX), WALK);

    expect(state.phase).toBe('payout');
    expect(state.toActSeat).toBeNull();
  });

  it('deals no more cards', () => {
    const dealt = preflop(SIX);
    const state = run(dealt, WALK);

    expect(state.board).toEqual([]);
    expect(state.deck).toEqual(dealt.deck);
  });

  it('pays the pot to the last player standing', () => {
    const state = run(preflop(SIX), WALK);

    expect(seatAt(state, 2).stack).toBe(1005);
    expect(seatAt(state, 1).stack).toBe(995);
    expect(state.pots).toEqual([]);
  });

  it('reports the award as an event', () => {
    const { events } = runWithEvents(preflop(SIX), WALK);

    expect(events).toContainEqual({ type: 'POT_AWARDED', seatIndex: 2, amount: 15, potIndex: 0 });
    expect(events).toContainEqual({ type: 'PHASE_CHANGED', from: 'preflop', to: 'payout' });
    expect(events.some((event) => event.type === 'BOARD_DEALT')).toBe(false);
    // Nobody called, so nobody has to show a card.
    expect(events.some((event) => event.type === 'HAND_REVEALED')).toBe(false);
  });

  it('does the same when the folds come on the flop', () => {
    const flop = run(preflop(SIX), [
      act.call(3),
      act.fold(4),
      act.fold(5),
      act.fold(0),
      act.fold(1),
      act.check(2),
      advance,
    ]);
    const state = run(flop, [act.bet(2, 60), act.fold(3)]);

    expect(state.phase).toBe('payout');
    expect(state.board).toHaveLength(3);
    expect(seatAt(state, 2).stack).toBe(1015);
  });

  it('hands every committed chip to the winner', () => {
    const state = run(preflop(SIX), [
      act.raise(3, 200),
      act.fold(4),
      act.fold(5),
      act.fold(0),
      act.fold(1),
      act.fold(2),
    ]);

    expect(seatAt(state, 3).stack).toBe(1015);
    expect(totalPot(state.pots)).toBe(0);
    expect(chipsInPlay(state)).toBe(6000);
  });

  it('settles to hand_end on the next ADVANCE_STREET', () => {
    const { state, events } = runWithEvents(preflop(SIX), [...WALK, advance]);

    expect(state.phase).toBe('hand_end');
    expect(state.handNumber).toBe(1);
    expect(events.at(-1)).toEqual({ type: 'HAND_ENDED', handNumber: 1 });
    expect(stacks(state)).toEqual([1000, 995, 1005, 1000, 1000, 1000]);
  });

  it('refuses a fold once the hand is over', () => {
    const state = run(preflop(SIX), WALK);

    expect(() => run(state, [act.fold(2)])).toThrow(/no betting is open in phase payout/);
  });
});
