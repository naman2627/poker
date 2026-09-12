import { describe, expect, it } from 'vitest';
import { isLive, type ConnectionStatus } from '../lib/store/table-store';
import { applyPatch } from '../lib/store/patch';
import { seat, tableState } from './helpers';

/**
 * The rule the whole reconnect story rests on: an action is only sent when the
 * table can actually hear it. Everything else — the badge, the banner, the
 * disabled bar — is a way of saying that out loud.
 */
describe('isLive', () => {
  it('is true only while the socket is open', () => {
    const states: ConnectionStatus[] = [
      'idle',
      'connecting',
      'open',
      'reconnecting',
      'closed',
      'error',
    ];
    expect(states.filter(isLive)).toEqual(['open']);
  });

  it('is false while reconnecting, however briefly', () => {
    // The trap this guards: "reconnecting" reads like a kind of connected, and
    // treating it as one is how a fold goes into a socket that is not there.
    expect(isLive('reconnecting')).toBe(false);
  });
});

describe('mucking, as the client sees it', () => {
  it('records a mucked seat without ever receiving a card for it', () => {
    const before = tableState({
      handId: 'h1',
      phase: 'showdown',
      seats: [seat(0, { cardCount: 2 }), seat(1, { cardCount: 2 }), seat(2, { cardCount: 2 })],
    });

    const { state } = applyPatch(before, 0, [
      {
        type: 'HAND_REVEALED',
        seatIndex: 1,
        cards: [
          { rank: 14, suit: 'h' },
          { rank: 9, suit: 'c' },
        ],
        handName: 'Three of a kind, nines',
        order: 0,
      },
      { type: 'HAND_MUCKED', seatIndex: 2, order: 1 },
    ]);

    expect(state.seats[1]?.holeCards).toHaveLength(2);
    expect(state.muckedSeats).toEqual([2]);
    // The muck event carries no cards, so there is nothing to write to the seat.
    expect(state.seats[2]?.holeCards).toBeNull();
  });

  it('does not need a resync to understand a muck', () => {
    const { resyncNeeded } = applyPatch(tableState({ seats: [seat(0)] }), 0, [
      { type: 'HAND_MUCKED', seatIndex: 0, order: 0 },
    ]);
    expect(resyncNeeded).toBe(false);
  });

  it('clears last hand’s mucks when a new one starts', () => {
    const before = tableState({ muckedSeats: [1, 2], seats: [seat(0), seat(1), seat(2)] });

    const { state } = applyPatch(before, 0, [
      {
        type: 'HAND_STARTED',
        handId: 'h2',
        handNumber: 2,
        buttonSeat: 0,
        sbSeat: 1,
        bbSeat: 2,
        dealtInSeats: [0, 1, 2],
      },
    ]);

    expect(state.muckedSeats).toEqual([]);
  });
});

describe('sitting out, as the client sees it', () => {
  it('follows the flag and keeps "ready" in step with it', () => {
    const before = tableState({ seats: [seat(0, { sittingOut: false, isReady: true })] });

    const out = applyPatch(before, 0, [
      { type: 'PLAYER_SITTING_OUT_CHANGED', seatIndex: 0, sittingOut: true },
    ]).state;
    expect(out.seats[0]?.sittingOut).toBe(true);
    expect(out.seats[0]?.isReady).toBe(false);

    const back = applyPatch(out, 0, [
      { type: 'PLAYER_SITTING_OUT_CHANGED', seatIndex: 0, sittingOut: false },
    ]).state;
    expect(back.seats[0]?.isReady).toBe(true);
  });

  it('leaves a seat with no chips out, whatever the flag says', () => {
    const before = tableState({ seats: [seat(0, { stack: 0, sittingOut: true })] });

    const { state } = applyPatch(before, 0, [
      { type: 'PLAYER_SITTING_OUT_CHANGED', seatIndex: 0, sittingOut: false },
    ]);

    // Being willing is not the same as being able.
    expect(state.seats[0]?.isReady).toBe(false);
  });
});
