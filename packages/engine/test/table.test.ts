/**
 * Sitting down, leaving, rebuying and running out the clock — everything around
 * the betting itself.
 */
import { describe, expect, it } from 'vitest';
import { createTable, legalActions } from '../src/index';
import {
  act,
  advance,
  chipsInPlay,
  dealHand,
  preflop,
  run,
  runWithEvents,
  seatAt,
  statuses,
  tableWith,
  timeout,
} from './helpers';

const SIX = [1000, 1000, 1000, 1000, 1000, 1000];

describe('createTable', () => {
  it('starts empty and waiting', () => {
    const table = createTable({ seatCount: 6, smallBlind: 5, bigBlind: 10 });

    expect(table.phase).toBe('waiting');
    expect(table.seats).toEqual([null, null, null, null, null, null]);
    expect(table.handNumber).toBe(0);
    expect(table.handId).toBeNull();
    expect(table.minRaise).toBe(10);
  });

  it('rejects a table nobody could play at', () => {
    expect(() => createTable({ seatCount: 1, smallBlind: 5, bigBlind: 10 })).toThrow(/seatCount/);
    expect(() => createTable({ seatCount: 6, smallBlind: 0, bigBlind: 10 })).toThrow(/blinds/);
    expect(() => createTable({ seatCount: 6, smallBlind: 20, bigBlind: 10 })).toThrow(
      /cannot exceed/,
    );
  });
});

describe('SIT', () => {
  it('seats a player out of the hand until the next one starts', () => {
    const state = tableWith([1000, 1000]);

    expect(seatAt(state, 0).status).toBe('sitting_out');
    expect(seatAt(state, 0).playerId).toBe('p0');
    expect(dealHand(state).seats.map((seat) => seat?.status)).toEqual(['active', 'active']);
  });

  it('refuses a taken seat, a seat off the table and a bad buy-in', () => {
    const state = tableWith([1000, 1000], { seatCount: 6 });

    expect(() => run(state, [{ type: 'SIT', seatIndex: 0, playerId: 'x', stack: 100 }])).toThrow(
      /already occupied/,
    );
    expect(() => run(state, [{ type: 'SIT', seatIndex: 9, playerId: 'x', stack: 100 }])).toThrow(
      /not a seat at this table/,
    );
    expect(() => run(state, [{ type: 'SIT', seatIndex: 4, playerId: 'x', stack: 0 }])).toThrow(
      /positive integer/,
    );
  });

  it('lets a player join mid-hand and deals them in next hand', () => {
    const midHand = run(preflop([1000, 1000, 1000], { seatCount: 4 }), [
      { type: 'SIT', seatIndex: 3, playerId: 'late', stack: 500 },
    ]);

    expect(seatAt(midHand, 3).status).toBe('sitting_out');
    expect(midHand.dealtInSeats).toEqual([0, 1, 2]);
  });
});

describe('LEAVE', () => {
  it('empties a seat outright between hands', () => {
    const { state, events } = runWithEvents(tableWith([1000, 1000, 1000]), [
      { type: 'LEAVE', seatIndex: 1 },
    ]);

    expect(state.seats[1]).toBeNull();
    expect(events).toEqual([{ type: 'PLAYER_LEFT', seatIndex: 1, playerId: 'p1' }]);
  });

  it('folds a player who leaves mid-hand but keeps their chips in the pot', () => {
    const state = run(preflop(SIX), [act.call(3), { type: 'LEAVE', seatIndex: 4 }]);

    expect(seatAt(state, 4).status).toBe('folded');
    expect(state.pendingLeave).toEqual([4]);
    expect(chipsInPlay(state)).toBe(6000);
  });

  it('passes the action on when the leaver was on the clock', () => {
    const state = run(preflop(SIX), [{ type: 'LEAVE', seatIndex: 3 }]);

    expect(state.toActSeat).toBe(4);
    expect(seatAt(state, 3).status).toBe('folded');
  });

  it('ends the hand when leaving takes the table down to one player', () => {
    const state = run(preflop([1000, 1000]), [{ type: 'LEAVE', seatIndex: 0 }]);

    expect(state.phase).toBe('payout');
    expect(seatAt(state, 1).stack).toBe(1005);
  });

  it('empties the seat once the hand is settled', () => {
    const state = run(preflop([1000, 1000]), [{ type: 'LEAVE', seatIndex: 0 }, advance]);

    expect(state.phase).toBe('hand_end');
    expect(state.seats[0]).toBeNull();
    expect(state.pendingLeave).toEqual([]);
  });
});

describe('REBUY', () => {
  it('tops a stack up between hands', () => {
    const { state, events } = runWithEvents(tableWith([1000, 1000]), [
      { type: 'REBUY', seatIndex: 0, amount: 500 },
    ]);

    expect(seatAt(state, 0).stack).toBe(1500);
    expect(events).toEqual([{ type: 'PLAYER_REBOUGHT', seatIndex: 0, amount: 500, stack: 1500 }]);
  });

  it('refuses a rebuy for a seat that is in the hand', () => {
    const state = preflop(SIX);

    expect(() => run(state, [{ type: 'REBUY', seatIndex: 3, amount: 500 }])).toThrow(
      /cannot rebuy in the middle of a hand/,
    );
  });

  it('allows a rebuy mid-hand for a seat that is sitting out', () => {
    const state = run(preflop([1000, 1000, 1000], { seatCount: 4 }), [
      { type: 'SIT', seatIndex: 3, playerId: 'late', stack: 500 },
      { type: 'REBUY', seatIndex: 3, amount: 500 },
    ]);

    expect(seatAt(state, 3).stack).toBe(1000);
  });

  it('refuses a rebuy of nothing', () => {
    expect(() =>
      run(tableWith([1000, 1000]), [{ type: 'REBUY', seatIndex: 0, amount: -5 }]),
    ).toThrow(/positive integer/);
  });
});

describe('TIMEOUT', () => {
  it('folds a seat that is facing a bet', () => {
    const { state, events } = runWithEvents(preflop(SIX), [timeout(3, 1_700_000_000_000)]);

    expect(seatAt(state, 3).status).toBe('folded');
    expect(state.toActSeat).toBe(4);
    expect(events[0]).toEqual({
      type: 'ACTION_TIMED_OUT',
      seatIndex: 3,
      now: 1_700_000_000_000,
      appliedAction: 'FOLD',
    });
  });

  it('checks rather than throwing a free hand away', () => {
    const flop = run(preflop(SIX), [
      act.fold(3),
      act.fold(4),
      act.fold(5),
      act.fold(0),
      act.call(1),
      act.check(2),
      advance,
    ]);
    const { state, events } = runWithEvents(flop, [timeout(1)]);

    expect(seatAt(state, 1).status).toBe('active');
    expect(state.toActSeat).toBe(2);
    expect(events[0]).toMatchObject({ type: 'ACTION_TIMED_OUT', appliedAction: 'CHECK' });
  });

  it('gives the big blind their option before timing them out', () => {
    const state = run(preflop(SIX), [
      act.call(3),
      act.call(4),
      act.call(5),
      act.call(0),
      act.call(1),
    ]);

    expect(legalActions(state, 2).canCheck).toBe(true);
    expect(run(state, [timeout(2)]).phase).toBe('preflop');
    expect(run(state, [timeout(2)]).toActSeat).toBeNull();
  });

  it('refuses to time out a seat that is not on the clock', () => {
    expect(() => run(preflop(SIX), [timeout(4)])).toThrow(/not on the clock/);
  });

  it('takes its timestamp from the command, never from the clock', () => {
    const { events } = runWithEvents(preflop(SIX), [timeout(3, 42)]);

    expect(events[0]).toMatchObject({ now: 42 });
  });
});

describe('phase guards', () => {
  it('refuses to start a hand in the middle of one', () => {
    expect(() => run(preflop(SIX), [{ type: 'START_HAND', handId: 'h2' }])).toThrow(
      /cannot start a hand from phase preflop/,
    );
  });

  it('refuses to deal hole cards twice', () => {
    expect(() => run(preflop(SIX), [{ type: 'DEAL_HOLE' }])).toThrow(/hole cards are dealt/);
  });

  it('refuses to advance a street before a hand exists', () => {
    expect(() => run(tableWith(SIX), [advance])).toThrow(/no street to advance from waiting/);
  });

  it('starts the next hand from hand_end and bumps the hand number', () => {
    const handOne = run(preflop([1000, 1000]), [act.fold(0), advance]);
    const handTwo = dealHand(handOne, 'hand-2');

    expect(handTwo.handNumber).toBe(2);
    expect(handTwo.handId).toBe('hand-2');
    expect(handTwo.board).toEqual([]);
    expect(statuses(handTwo)).toEqual(['active', 'active']);
  });
});

describe('leaving before the deal', () => {
  it('deals no cards to a seat that left during hand_start', () => {
    const started = run(tableWith([1000, 1000, 1000]), [
      { type: 'START_HAND', handId: 'h' },
      { type: 'POST_BLINDS' },
      { type: 'LEAVE', seatIndex: 0 },
      { type: 'DEAL_HOLE' },
    ]);

    expect(seatAt(started, 0).holeCards).toEqual([]);
    expect(seatAt(started, 0).status).toBe('folded');
    expect(seatAt(started, 1).holeCards).toHaveLength(2);
    expect(started.deck).toHaveLength(48);
    expect(started.toActSeat).toBe(1);
  });
});
