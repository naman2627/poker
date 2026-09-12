import { describe, expect, it } from 'vitest';
import { announce } from '../lib/announce';
import { seat, tableState } from './helpers';

/**
 * The live region reads these strings out. A player who cannot see the felt
 * hears the hand through them, so they have to name the player, the action and
 * the amount — "Naman raised to 400", not "raise".
 */
const state = tableState({
  seats: [seat(0, { displayName: 'Priya' }), seat(1, { displayName: 'Naman' }), seat(2)],
});

const say = (event: Parameters<typeof announce>[0]): string | null =>
  announce(event, state, 'id')?.text ?? null;

describe('announce', () => {
  it('names the player, the action and the amount', () => {
    expect(
      say({
        type: 'PLAYER_ACTED',
        seatIndex: 1,
        action: 'RAISE',
        committedThisRound: 400,
        allIn: false,
      }),
    ).toBe('Naman raises to 400.');
  });

  it('says when an action was also an all in', () => {
    expect(
      say({
        type: 'PLAYER_ACTED',
        seatIndex: 0,
        action: 'CALL',
        committedThisRound: 135,
        allIn: true,
      }),
    ).toBe('Priya calls all in for 135.');
  });

  it('reads cards as words, not symbols', () => {
    expect(
      say({
        type: 'BOARD_DEALT',
        phase: 'flop',
        cards: [
          { rank: 13, suit: 's' },
          { rank: 9, suit: 'h' },
          { rank: 4, suit: 'd' },
        ],
      }),
    ).toBe('The flop: king of spades, nine of hearts, four of diamonds.');
  });

  it('marks a pot award as worth interrupting for', () => {
    const line = announce(
      { type: 'POT_AWARDED', seatIndex: 1, amount: 430, potIndex: 1 },
      state,
      'x',
    );
    expect(line?.text).toBe('Naman wins 430 from side pot 1.');
    expect(line?.assertive).toBe(true);
  });

  it('falls back to a seat number for somebody who has since left', () => {
    expect(
      say({
        type: 'PLAYER_ACTED',
        seatIndex: 7,
        action: 'FOLD',
        committedThisRound: 0,
        allIn: false,
      }),
    ).toBe('Seat 8 folds.');
  });

  it('stays quiet about bookkeeping the felt already shows', () => {
    expect(say({ type: 'ACTION_ON', seatIndex: 1 })).toBeNull();
    expect(say({ type: 'PHASE_CHANGED', from: 'flop', to: 'turn' })).toBeNull();
  });
});
