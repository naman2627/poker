/**
 * Pot resolution: which layer goes to whom, how a tie is split, and where the
 * chip that will not divide ends up.
 */
import { describe, expect, it } from 'vitest';
import { buildPots, resolveShowdown, seededRng, totalPot } from '../src/index';
import { act, advance, dealHand, runWithEvents, showdownTable, stacks, tableWith } from './helpers';

describe('a three-way all-in for three different stacks', () => {
  // Seat 1 is in for 100, seat 2 for 300, seat 3 for 500, all of it all-in.
  // Board: nothing anybody pairs by accident.
  const table = showdownTable({
    board: '9s 5h 2c Jh 4d',
    buttonSeat: 0,
    seatCount: 4,
    seats: [
      { seatIndex: 1, hole: '9c 9d', committed: 100 },
      { seatIndex: 2, hole: 'Jc 5c', committed: 300 },
      { seatIndex: 3, hole: 'Ac Kc', committed: 500 },
    ],
  });

  it('builds a main pot and two side pots', () => {
    expect(table.pots).toEqual([
      { amount: 300, eligibleSeats: [1, 2, 3] },
      { amount: 400, eligibleSeats: [2, 3] },
      { amount: 200, eligibleSeats: [3] },
    ]);
  });

  it('accounts for every chip that went in', () => {
    const committed = 100 + 300 + 500;
    const { awards } = resolveShowdown(table);

    expect(totalPot(table.pots)).toBe(committed);
    expect(awards.reduce((sum, award) => sum + award.amount, 0)).toBe(committed);
  });

  it('gives the short stack the main pot it can win, and nothing above it', () => {
    const { awards } = resolveShowdown(table);

    // Seat 1 has trip nines, seat 2 two pair, seat 3 ace high.
    expect(awards).toEqual([
      { seatIndex: 1, amount: 300, potIndex: 0 },
      { seatIndex: 2, amount: 400, potIndex: 1 },
      { seatIndex: 3, amount: 200, potIndex: 2 },
    ]);
    expect(awards.filter((award) => award.seatIndex === 1)).toHaveLength(1);
  });

  it('shows the hands that were compared, and names them', () => {
    const { revealed } = resolveShowdown(table);

    expect(revealed.map((reveal) => [reveal.seatIndex, reveal.handName])).toEqual([
      [1, 'Three of a kind, nines'],
      [2, 'Two pair, jacks and fives'],
      [3, 'Ace high'],
    ]);
  });

  /**
   * The readable name and the comparable category say the same thing about the
   * same hand. The category is what a counter can work with — it is what the
   * lifetime "best hand" statistic is built out of — so a reveal carries both.
   */
  it('carries the category beside the name', () => {
    const { revealed } = resolveShowdown(table);

    expect(revealed.map((reveal) => reveal.category)).toEqual(['TRIPS', 'TWO_PAIR', 'HIGH_CARD']);
  });
});

describe('a short stack that wins the main pot but not the side pot', () => {
  const table = showdownTable({
    board: '9s 5h 2c Jh 4d',
    buttonSeat: 0,
    seatCount: 4,
    seats: [
      // The short stack makes the best hand at the table.
      { seatIndex: 1, hole: '9c 9d', committed: 50 },
      { seatIndex: 2, hole: '5s 5d', committed: 400 },
      { seatIndex: 3, hole: 'Jc 5c', committed: 400 },
    ],
  });

  it('pays the main pot to the short stack', () => {
    const { awards } = resolveShowdown(table);

    expect(table.pots[0]).toEqual({ amount: 150, eligibleSeats: [1, 2, 3] });
    expect(awards).toContainEqual({ seatIndex: 1, amount: 150, potIndex: 0 });
  });

  it('pays the side pot to the best of the seats that could contest it', () => {
    const { awards } = resolveShowdown(table);

    // Seat 2 has trip fives, seat 3 two pair; seat 1 cannot win this layer
    // however good its hand is.
    expect(table.pots[1]).toEqual({ amount: 700, eligibleSeats: [2, 3] });
    expect(awards).toContainEqual({ seatIndex: 2, amount: 700, potIndex: 1 });
    expect(awards.some((award) => award.seatIndex === 1 && award.potIndex === 1)).toBe(false);
  });

  it('leaves the short stack with only what it could cover', () => {
    const { awards } = resolveShowdown(table);
    const toSeatOne = awards
      .filter((award) => award.seatIndex === 1)
      .reduce((sum, award) => sum + award.amount, 0);

    expect(toSeatOne).toBe(150);
    expect(awards.reduce((sum, award) => sum + award.amount, 0)).toBe(850);
  });
});

describe('a player who put in the most chips and then folded', () => {
  const table = showdownTable({
    board: '9s 5h 2c Jh 4d',
    buttonSeat: 0,
    seatCount: 4,
    seats: [
      { seatIndex: 1, hole: '9c 9d', committed: 100 },
      { seatIndex: 2, hole: 'Jc 5c', committed: 300 },
      // Bet 500, then folded to a raise it did not want to call.
      { seatIndex: 3, hole: 'Ac Kc', committed: 500, status: 'folded' },
    ],
  });

  it('leaves their chips in the pots', () => {
    expect(totalPot(table.pots)).toBe(900);
  });

  it('never makes them eligible for a layer', () => {
    for (const pot of table.pots) {
      expect(pot.eligibleSeats).not.toContain(3);
    }
    expect(table.pots).toEqual([
      { amount: 300, eligibleSeats: [1, 2] },
      { amount: 600, eligibleSeats: [2] },
    ]);
  });

  it('hands their uncalled chips to the seats still in the hand', () => {
    const { awards, revealed } = resolveShowdown(table);

    expect(awards).toEqual([
      { seatIndex: 1, amount: 300, potIndex: 0 },
      { seatIndex: 2, amount: 600, potIndex: 1 },
    ]);
    expect(awards.reduce((sum, award) => sum + award.amount, 0)).toBe(900);
    expect(revealed.map((reveal) => reveal.seatIndex)).toEqual([1, 2]);
  });
});

describe('a split pot with an odd chip', () => {
  // Two identical hands and a pot that will not halve: the folded small blind
  // left a single chip behind.
  const tied = 'As Kd 9c 4h 2s';

  it('gives the odd chip to the first eligible seat left of the button', () => {
    const table = showdownTable({
      board: tied,
      buttonSeat: 0,
      seatCount: 4,
      seats: [
        { seatIndex: 1, hole: 'Ah Kh', committed: 50 },
        { seatIndex: 2, hole: 'Ac Kc', committed: 50 },
        { seatIndex: 3, committed: 1, status: 'folded' },
      ],
    });

    const { awards } = resolveShowdown(table);

    expect(totalPot(table.pots)).toBe(101);
    expect(awards).toEqual([
      { seatIndex: 1, amount: 51, potIndex: 0 },
      { seatIndex: 2, amount: 50, potIndex: 0 },
    ]);
  });

  it('follows the button rather than the seat numbers', () => {
    const table = showdownTable({
      board: tied,
      // The button is seat 2, so seat 3 is the first seat to its left.
      buttonSeat: 2,
      seatCount: 4,
      seats: [
        { seatIndex: 1, hole: 'Ah Kh', committed: 50 },
        { seatIndex: 3, hole: 'Ac Kc', committed: 50 },
        { seatIndex: 0, committed: 1, status: 'folded' },
      ],
    });

    const { awards } = resolveShowdown(table);

    expect(awards).toEqual([
      { seatIndex: 3, amount: 51, potIndex: 0 },
      { seatIndex: 1, amount: 50, potIndex: 0 },
    ]);
  });

  it('spreads several odd chips one at a time from the button', () => {
    const table = showdownTable({
      board: tied,
      buttonSeat: 0,
      seatCount: 4,
      seats: [
        { seatIndex: 1, hole: 'Ah Kh', committed: 33 },
        { seatIndex: 2, hole: 'Ac Kc', committed: 33 },
        { seatIndex: 3, hole: 'Ad Ks', committed: 33 },
        { seatIndex: 0, committed: 2, status: 'folded' },
      ],
    });

    const { awards } = resolveShowdown(table);

    expect(totalPot(table.pots)).toBe(101);
    expect(awards).toEqual([
      { seatIndex: 1, amount: 34, potIndex: 0 },
      { seatIndex: 2, amount: 34, potIndex: 0 },
      { seatIndex: 3, amount: 33, potIndex: 0 },
    ]);
  });
});

describe('the board plays', () => {
  const table = showdownTable({
    board: 'As Ks Qs Js Ts',
    buttonSeat: 0,
    seatCount: 4,
    seats: [
      { seatIndex: 1, hole: '2h 3c', committed: 100 },
      { seatIndex: 2, hole: '4d 6c', committed: 100 },
      { seatIndex: 3, hole: '7h 8d', committed: 100 },
    ],
  });

  it('chops the pot evenly between everyone still in', () => {
    const { awards } = resolveShowdown(table);

    expect(awards).toEqual([
      { seatIndex: 1, amount: 100, potIndex: 0 },
      { seatIndex: 2, amount: 100, potIndex: 0 },
      { seatIndex: 3, amount: 100, potIndex: 0 },
    ]);
  });

  it('names the same hand for all of them', () => {
    const { revealed } = resolveShowdown(table);

    expect(revealed.map((reveal) => reveal.handName)).toEqual([
      'Royal flush',
      'Royal flush',
      'Royal flush',
    ]);
  });
});

describe('resolveShowdown guards', () => {
  it('hands an uncontested pot over without anyone showing a card', () => {
    const table = showdownTable({
      board: '',
      buttonSeat: 0,
      seatCount: 3,
      seats: [
        { seatIndex: 1, committed: 40 },
        { seatIndex: 2, committed: 10, status: 'folded' },
      ],
    });

    const { awards, revealed } = resolveShowdown(table);

    expect(awards).toEqual([{ seatIndex: 1, amount: 50, potIndex: 0 }]);
    expect(revealed).toEqual([]);
  });

  it('refuses a contested pot without a full board', () => {
    const table = showdownTable({
      board: '9s 5h 2c',
      buttonSeat: 0,
      seatCount: 3,
      seats: [
        { seatIndex: 1, hole: '9c 9d', committed: 40 },
        { seatIndex: 2, hole: 'Jc 5c', committed: 40 },
      ],
    });

    expect(() => resolveShowdown(table)).toThrow(/contested showdown with 5 cards/);
  });

  it('has nothing to do when no chips went in', () => {
    const table = showdownTable({
      board: 'As Ks Qs Js Ts',
      seats: [{ seatIndex: 1, hole: '2h 3c', committed: 0 }],
    });

    expect(buildPots(table.seats)).toEqual([]);
    expect(resolveShowdown(table)).toEqual({ awards: [], revealed: [], mucked: [] });
  });
});

describe('a chop through the reducer', () => {
  it('splits a real hand between two seats that tie', () => {
    // On this deck the short all-in blind and the big blind end up with the
    // same hand, so the main pot comes back to them in equal halves.
    const dealt = dealHand(tableWith([1000, 3, 1000]), 'hand-1', seededRng('test'));
    const { state, events } = runWithEvents(dealt, [act.fold(0), act.check(2), advance, advance]);

    expect(state.phase).toBe('payout');
    expect(events.filter((event) => event.type === 'POT_AWARDED')).toEqual([
      { type: 'POT_AWARDED', seatIndex: 1, amount: 3, potIndex: 0 },
      { type: 'POT_AWARDED', seatIndex: 2, amount: 3, potIndex: 0 },
      // The 7 the short stack could not cover goes back to the big blind.
      { type: 'POT_AWARDED', seatIndex: 2, amount: 7, potIndex: 1 },
    ]);
    expect(stacks(state)).toEqual([1000, 3, 1000]);
  });
});
