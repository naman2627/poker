/**
 * One six-handed hand, driven from START_HAND to hand_end, with the state
 * checked after every single command. If the engine ever drifts, this is the
 * test that says exactly where.
 *
 * Stacks: seat 0 and 1 and 2 have 1000, seat 3 has 600, seat 4 has 250, seat 5
 * has 80. Blinds are 5 and 10, so the button is seat 0, small blind seat 1, big
 * blind seat 2.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  legalActions,
  reduce,
  seededRng,
  totalPot,
  type Card,
  type Command,
  type EngineEvent,
  type TableState,
} from '../src/index';
import { act, advance, chipsInPlay, seatAt, stacks, statuses, tableWith } from './helpers';

const STACKS = [1000, 1000, 1000, 600, 250, 80];
const TOTAL_CHIPS = 3930;

describe('a scripted six-handed hand', () => {
  let state: TableState;
  let events: EngineEvent[];
  /** The shuffled deck as it stood before a single card was dealt. */
  let deck: readonly Card[];
  const rng = seededRng('scripted-hand');

  const send = (command: Command): void => {
    const result = reduce(state, command, rng);
    state = result.state;
    events = [...result.events];
  };

  beforeEach(() => {
    state = tableWith(STACKS);
    events = [];
    deck = [];
  });

  it('plays out card for card and chip for chip', () => {
    // ---- START_HAND -------------------------------------------------------
    send({ type: 'START_HAND', handId: 'hand-1' });
    deck = state.deck;

    expect(state.phase).toBe('hand_start');
    expect(state.handId).toBe('hand-1');
    expect(state.handNumber).toBe(1);
    expect([state.buttonSeat, state.sbSeat, state.bbSeat]).toEqual([0, 1, 2]);
    expect(state.dealtInSeats).toEqual([0, 1, 2, 3, 4, 5]);
    expect(state.deck).toHaveLength(52);
    expect(state.board).toEqual([]);
    expect(state.pots).toEqual([]);
    expect(statuses(state)).toEqual(Array<string>(6).fill('active'));
    expect(events).toEqual([
      { type: 'PHASE_CHANGED', from: 'waiting', to: 'hand_start' },
      {
        type: 'HAND_STARTED',
        handId: 'hand-1',
        handNumber: 1,
        buttonSeat: 0,
        sbSeat: 1,
        bbSeat: 2,
        dealtInSeats: [0, 1, 2, 3, 4, 5],
      },
    ]);

    // ---- POST_BLINDS ------------------------------------------------------
    send({ type: 'POST_BLINDS' });

    expect(state.phase).toBe('hand_start');
    expect(stacks(state)).toEqual([1000, 995, 990, 600, 250, 80]);
    expect(seatAt(state, 1).committedThisRound).toBe(5);
    expect(seatAt(state, 2).committedThisRound).toBe(10);
    expect(state.currentBet).toBe(10);
    expect(state.minRaise).toBe(10);
    expect(state.lastAggressorSeat).toBe(2);
    // Nobody is all-in, so the blinds sit in one pot rather than in layers.
    expect(state.pots).toEqual([{ amount: 15, eligibleSeats: [1, 2] }]);
    // Posting is not acting: both blinds still owe an action.
    expect(seatAt(state, 1).hasActedThisRound).toBe(false);
    expect(seatAt(state, 2).hasActedThisRound).toBe(false);

    // ---- DEAL_HOLE --------------------------------------------------------
    send({ type: 'DEAL_HOLE' });

    expect(state.phase).toBe('preflop');
    expect(state.deck).toHaveLength(40);
    expect(state.deck).toEqual(deck.slice(12));
    // Two at a time, one card each, starting to the left of the button.
    expect(seatAt(state, 1).holeCards).toEqual([deck[0], deck[6]]);
    expect(seatAt(state, 2).holeCards).toEqual([deck[1], deck[7]]);
    expect(seatAt(state, 3).holeCards).toEqual([deck[2], deck[8]]);
    expect(seatAt(state, 4).holeCards).toEqual([deck[3], deck[9]]);
    expect(seatAt(state, 5).holeCards).toEqual([deck[4], deck[10]]);
    expect(seatAt(state, 0).holeCards).toEqual([deck[5], deck[11]]);
    expect(events).toContainEqual({
      type: 'HOLE_CARDS_DEALT',
      seats: [1, 2, 3, 4, 5, 0],
      cardsPerSeat: 2,
    });
    // Preflop opens under the gun, to the left of the big blind.
    expect(state.toActSeat).toBe(3);

    // ---- preflop betting --------------------------------------------------
    expect(legalActions(state, 3)).toMatchObject({ callAmount: 10, minRaiseTo: 20 });

    send(act.raise(3, 40));
    expect(state.currentBet).toBe(40);
    expect(state.minRaise).toBe(30);
    expect(seatAt(state, 3).stack).toBe(560);
    expect(state.toActSeat).toBe(4);

    send(act.call(4));
    expect(seatAt(state, 4).stack).toBe(210);
    expect(state.toActSeat).toBe(5);

    // Seat 5 shoves 80: 40 over the current bet, which is a full raise.
    send(act.allIn(5));
    expect(state.currentBet).toBe(80);
    expect(state.minRaise).toBe(40);
    expect(seatAt(state, 5).status).toBe('allin');
    expect(seatAt(state, 3).hasActedThisRound).toBe(false);
    expect(seatAt(state, 4).hasActedThisRound).toBe(false);
    expect(state.toActSeat).toBe(0);

    send(act.fold(0));
    expect(state.toActSeat).toBe(1);

    send(act.fold(1));
    expect(state.toActSeat).toBe(2);

    send(act.call(2));
    expect(seatAt(state, 2).stack).toBe(920);
    // Seats 3 and 4 owe the difference between 40 and 80.
    expect(state.toActSeat).toBe(3);

    send(act.call(3));
    expect(seatAt(state, 3).stack).toBe(520);
    expect(state.toActSeat).toBe(4);

    send(act.call(4));
    expect(seatAt(state, 4).stack).toBe(170);
    expect(state.toActSeat).toBeNull();
    expect(events).toContainEqual({ type: 'BETTING_ROUND_ENDED', phase: 'preflop' });
    expect(state.pots).toEqual([{ amount: 325, eligibleSeats: [2, 3, 4, 5] }]);

    // ---- flop -------------------------------------------------------------
    send(advance);

    expect(state.phase).toBe('flop');
    expect(state.board).toEqual([deck[12], deck[13], deck[14]]);
    expect(state.deck).toHaveLength(37);
    expect(state.currentBet).toBe(0);
    expect(state.minRaise).toBe(10);
    expect(state.lastAggressorSeat).toBeNull();
    // Postflop opens to the left of the button; seat 1 folded, so seat 2.
    expect(state.toActSeat).toBe(2);
    expect(seatAt(state, 2).committedThisRound).toBe(0);

    send(act.bet(2, 100));
    expect(state.currentBet).toBe(100);
    expect(state.minRaise).toBe(100);
    expect(seatAt(state, 2).stack).toBe(820);
    expect(state.toActSeat).toBe(3);

    send(act.call(3));
    expect(seatAt(state, 3).stack).toBe(420);
    expect(state.toActSeat).toBe(4);

    // Seat 4's last 170 is only 70 more: short of a full raise.
    send(act.allIn(4));
    expect(state.currentBet).toBe(170);
    expect(state.minRaise).toBe(100);
    expect(seatAt(state, 4).status).toBe('allin');
    expect(state.toActSeat).toBe(2);
    expect(legalActions(state, 2)).toMatchObject({
      canCall: true,
      callAmount: 70,
      canRaise: false,
      minRaiseTo: 0,
    });

    send(act.call(2));
    expect(seatAt(state, 2).stack).toBe(750);
    expect(state.toActSeat).toBe(3);

    send(act.call(3));
    expect(seatAt(state, 3).stack).toBe(350);
    expect(state.toActSeat).toBeNull();
    expect(state.pots).toEqual([
      { amount: 325, eligibleSeats: [2, 3, 4, 5] },
      { amount: 510, eligibleSeats: [2, 3, 4] },
    ]);

    // ---- turn -------------------------------------------------------------
    send(advance);

    expect(state.phase).toBe('turn');
    expect(state.board).toEqual([deck[12], deck[13], deck[14], deck[15]]);
    expect(state.toActSeat).toBe(2);

    send(act.check(2));
    expect(state.toActSeat).toBe(3);

    send(act.allIn(3));
    expect(state.currentBet).toBe(350);
    expect(state.minRaise).toBe(350);
    expect(seatAt(state, 3).status).toBe('allin');
    expect(state.toActSeat).toBe(2);

    send(act.call(2));
    expect(seatAt(state, 2).stack).toBe(400);
    expect(state.toActSeat).toBeNull();
    expect(state.pots).toEqual([
      { amount: 325, eligibleSeats: [2, 3, 4, 5] },
      { amount: 510, eligibleSeats: [2, 3, 4] },
      { amount: 700, eligibleSeats: [2, 3] },
    ]);

    // ---- river: only seat 2 has chips left, so it runs out ----------------
    send(advance);

    expect(state.phase).toBe('showdown');
    expect(state.board).toEqual(deck.slice(12, 17));
    expect(state.toActSeat).toBeNull();
    // Cards go face up here, a phase before the chips move.
    //
    // Seat 3 made the last aggressive action of the hand — the all-in on the
    // turn — so it turns over first and the rest follow clockwise. Seats 4 and 5
    // cannot beat what is already face up, so they muck and their cards never
    // leave the server. Seat 2 can, and does.
    expect(events.map((event) => event.type)).toEqual([
      'PHASE_CHANGED',
      'BOARD_DEALT',
      'PHASE_CHANGED',
      'SHOWDOWN_REACHED',
      'HAND_REVEALED',
      'HAND_MUCKED',
      'HAND_MUCKED',
      'HAND_REVEALED',
    ]);
    expect(events).toContainEqual({ type: 'SHOWDOWN_REACHED', seats: [3, 4, 5, 2] });

    const shown = events.filter(
      (event) => event.type === 'HAND_REVEALED' || event.type === 'HAND_MUCKED',
    );
    expect(shown.map((event) => event.seatIndex)).toEqual([3, 4, 5, 2]);
    expect(
      events.filter((event) => event.type === 'HAND_REVEALED').map((event) => event.handName),
    ).toEqual(['Two pair, queens and eights', 'Three of a kind, eights']);
    expect(
      events.filter((event) => event.type === 'HAND_MUCKED').map((event) => event.seatIndex),
    ).toEqual([4, 5]);

    // ---- payout -----------------------------------------------------------
    send(advance);

    expect(state.phase).toBe('payout');
    expect(events.filter((event) => event.type === 'HAND_REVEALED')).toEqual([]);
    expect(events.filter((event) => event.type === 'POT_AWARDED')).toEqual([
      { type: 'POT_AWARDED', seatIndex: 2, amount: 325, potIndex: 0 },
      { type: 'POT_AWARDED', seatIndex: 2, amount: 510, potIndex: 1 },
      { type: 'POT_AWARDED', seatIndex: 2, amount: 700, potIndex: 2 },
    ]);
    expect(totalPot(state.pots)).toBe(0);
    expect(stacks(state)).toEqual([1000, 995, 1935, 0, 0, 0]);

    // ---- hand_end ---------------------------------------------------------
    send(advance);

    expect(state.phase).toBe('hand_end');
    expect(events.at(-1)).toEqual({ type: 'HAND_ENDED', handNumber: 1 });
    expect(statuses(state)).toEqual(['folded', 'folded', 'active', 'allin', 'allin', 'allin']);
    expect(chipsInPlay(state)).toBe(TOTAL_CHIPS);
  });

  it('replays to exactly the same place', () => {
    const commands: Command[] = [
      { type: 'START_HAND', handId: 'hand-1' },
      { type: 'POST_BLINDS' },
      { type: 'DEAL_HOLE' },
      act.raise(3, 40),
      act.call(4),
      act.allIn(5),
      act.fold(0),
      act.fold(1),
      act.call(2),
      act.call(3),
      act.call(4),
      advance,
    ];

    const play = (): string => {
      const replayRng = seededRng('scripted-hand');
      let replayed = tableWith(STACKS);
      for (const command of commands) replayed = reduce(replayed, command, replayRng).state;
      return JSON.stringify(replayed);
    };

    expect(play()).toBe(play());
  });
});
