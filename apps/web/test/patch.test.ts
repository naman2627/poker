import { describe, expect, it } from 'vitest';
import type { TableEvent } from '@poker/shared';
import { applyPatch, chipsOnFelt, potTotal } from '../lib/store/patch';
import { seat, tableState } from './helpers';

/**
 * The patch reducer is the only place the client changes the table between whole
 * states, so it is the only place a client-side bug could invent something the
 * server never said. These tests are about exactly that: what it writes, and
 * what it refuses to guess.
 */
describe('applyPatch', () => {
  it('moves chips from the stack to the street total on PLAYER_ACTED', () => {
    const before = tableState({
      handId: 'h1',
      phase: 'preflop',
      seats: [seat(0, { stack: 1000 }), seat(1), seat(2)],
    });

    const { state } = applyPatch(before, 0, [
      { type: 'PLAYER_ACTED', seatIndex: 0, action: 'RAISE', committedThisRound: 30, allIn: false },
    ]);

    expect(state.seats[0]?.stack).toBe(970);
    expect(state.seats[0]?.committedThisRound).toBe(30);
    expect(state.seats[0]?.committedThisHand).toBe(30);
    expect(state.currentBet).toBe(30);
    expect(state.lastAggressorSeat).toBe(0);
  });

  it('charges only the difference when a seat raises twice on one street', () => {
    const before = tableState({
      seats: [seat(0, { stack: 970, committedThisRound: 30, committedThisHand: 30 })],
    });

    const { state } = applyPatch(before, 0, [
      { type: 'PLAYER_ACTED', seatIndex: 0, action: 'RAISE', committedThisRound: 90, allIn: false },
    ]);

    expect(state.seats[0]?.stack).toBe(910);
    expect(state.seats[0]?.committedThisHand).toBe(90);
  });

  it('is idempotent for an action already applied by a full state', () => {
    // The server sends a sync and the patch describing the same change; totals
    // on the wire are absolute for exactly this reason.
    const applied = tableState({
      seats: [seat(0, { stack: 970, committedThisRound: 30, committedThisHand: 30 })],
    });

    const again: TableEvent = {
      type: 'PLAYER_ACTED',
      seatIndex: 0,
      action: 'RAISE',
      committedThisRound: 30,
      allIn: false,
    };

    expect(applyPatch(applied, 0, [again]).state.seats[0]?.stack).toBe(970);
  });

  it('marks a folded seat folded and an all-in seat all in', () => {
    const before = tableState({ seats: [seat(0), seat(1, { stack: 40 })] });

    const { state } = applyPatch(before, 0, [
      { type: 'PLAYER_ACTED', seatIndex: 0, action: 'FOLD', committedThisRound: 10, allIn: false },
      { type: 'PLAYER_ACTED', seatIndex: 1, action: 'ALL_IN', committedThisRound: 40, allIn: true },
    ]);

    expect(state.seats[0]?.status).toBe('folded');
    expect(state.seats[1]?.status).toBe('allin');
    expect(state.seats[1]?.stack).toBe(0);
  });

  it('clears the felt when the street closes but keeps the pot whole', () => {
    const before = tableState({
      seats: [
        seat(0, { stack: 970, committedThisRound: 30, committedThisHand: 30 }),
        seat(1, { stack: 970, committedThisRound: 30, committedThisHand: 30 }),
      ],
    });

    const { state } = applyPatch(before, 0, [{ type: 'BETTING_ROUND_ENDED', phase: 'preflop' }]);

    expect(chipsOnFelt(state)).toBe(0);
    expect(state.currentBet).toBe(0);
    expect(state.toActSeat).toBeNull();
    // The chips went into the middle, not out of existence.
    expect(potTotal(state, 0)).toBe(60);
  });

  it('appends board cards without disturbing the ones already out', () => {
    const before = tableState({
      phase: 'flop',
      board: [
        { rank: 13, suit: 's' },
        { rank: 9, suit: 'h' },
        { rank: 4, suit: 'd' },
      ],
    });

    const { state } = applyPatch(before, 0, [
      { type: 'BOARD_DEALT', phase: 'turn', cards: [{ rank: 12, suit: 'c' }] },
    ]);

    expect(state.board).toHaveLength(4);
    expect(state.board[3]).toEqual({ rank: 12, suit: 'c' });
  });

  it('turns cards face up only when the server reveals them', () => {
    const before = tableState({ seats: [seat(0, { cardCount: 2 }), seat(1, { cardCount: 2 })] });

    const { state } = applyPatch(before, 0, [
      {
        type: 'HAND_REVEALED',
        seatIndex: 1,
        cards: [
          { rank: 14, suit: 'h' },
          { rank: 9, suit: 'c' },
        ],
        handName: 'Three of a kind, nines',
      },
    ]);

    expect(state.seats[1]?.holeCards).toHaveLength(2);
    // Seat 0 was not revealed, so it stays face down. The client cannot and does
    // not fill this in.
    expect(state.seats[0]?.holeCards).toBeNull();
  });

  it('pays a pot into a stack and takes it out of the total', () => {
    const before = tableState({
      seats: [seat(0, { stack: 0, committedThisHand: 165 }), seat(1, { committedThisHand: 165 })],
    });

    const { state, awarded } = applyPatch(before, 0, [
      { type: 'POT_AWARDED', seatIndex: 0, amount: 330, potIndex: 0 },
    ]);

    expect(state.seats[0]?.stack).toBe(330);
    expect(awarded).toBe(330);
    expect(potTotal(state, awarded)).toBe(0);
  });

  it('resets every seat when a new hand starts', () => {
    const before = tableState({
      seats: [
        seat(0, { status: 'folded', committedThisRound: 30, committedThisHand: 30, cardCount: 2 }),
        seat(1, { status: 'allin', committedThisHand: 165, holeCards: [{ rank: 14, suit: 'h' }] }),
      ],
      board: [{ rank: 13, suit: 's' }],
    });

    const { state } = applyPatch(before, 200, [
      {
        type: 'HAND_STARTED',
        handId: 'h2',
        handNumber: 2,
        buttonSeat: 1,
        sbSeat: 0,
        bbSeat: 1,
        dealtInSeats: [0, 1],
      },
    ]);

    expect(state.board).toEqual([]);
    expect(state.seats[0]?.status).toBe('active');
    expect(state.seats[1]?.holeCards).toBeNull();
    expect(potTotal(state, 0)).toBe(0);
  });

  it('asks for a resync rather than guessing at an event it does not know', () => {
    const { resyncNeeded } = applyPatch(tableState(), 0, [{ type: 'SOMETHING_NEW_ENTIRELY' }]);
    expect(resyncNeeded).toBe(true);
  });

  it('asks for a resync when a phase change means the pot layers moved', () => {
    const { phaseChanged } = applyPatch(tableState(), 0, [
      { type: 'PHASE_CHANGED', from: 'preflop', to: 'flop' },
    ]);
    expect(phaseChanged).toBe(true);
  });

  it('refuses a malformed card rather than rendering half a board', () => {
    const { resyncNeeded, state } = applyPatch(tableState(), 0, [
      { type: 'BOARD_DEALT', phase: 'flop', cards: [{ rank: 13, suit: 'x' }] },
    ]);

    expect(resyncNeeded).toBe(true);
    expect(state.board).toEqual([]);
  });

  it('applies a timeout as the action the server says it became', () => {
    const before = tableState({
      seats: [seat(0, { stack: 500, committedThisRound: 20, committedThisHand: 20 })],
    });

    const { state } = applyPatch(before, 0, [
      { type: 'ACTION_TIMED_OUT', seatIndex: 0, now: 1, appliedAction: 'FOLD' },
    ]);

    expect(state.seats[0]?.status).toBe('folded');
    // Folding costs nothing more than what was already in.
    expect(state.seats[0]?.stack).toBe(500);
  });
});

describe('potTotal', () => {
  it('adds up what every seat has committed to the hand', () => {
    const state = tableState({
      seats: [
        seat(0, { committedThisHand: 380 }),
        seat(1, { committedThisHand: 10, status: 'folded' }),
        seat(2, { committedThisHand: 165 }),
      ],
    });

    // Including the folded seat: those chips are in the middle too.
    expect(potTotal(state, 0)).toBe(555);
  });
});
