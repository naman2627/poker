import { describe, expect, it } from 'vitest';
import { createDeck, shuffle } from '../src/deck';
import { dealOrder, planDeal } from '../src/deal';
import { createSeedRng } from '../src/rng';
import type { TableState } from '../src/types';
import { act, advance, dealHand, run, seatAt, tableWith } from './helpers';

/**
 * The shuffle behind the fairness commitment.
 *
 * Two things are being pinned here, and the second is the important one.
 *
 * First, that the seed is used in full: a commitment nobody can open early is
 * the entire point, and an RNG that folded 256 bits down to 32 would let anyone
 * brute-force the deck between the commit and the reveal.
 *
 * Second, that it never changes. Every hand this server ever records is audited
 * by re-running `createSeedRng` and comparing. The literal decks below are that
 * promise written down — if a change to the RNG makes them fail, it has also
 * made every stored hand unverifiable, and the right move is to revert it.
 */
const SEED_A = '00'.repeat(32);
const SEED_B = 'a3f1'.repeat(16);

const asText = (cards: readonly { rank: number; suit: string }[]): string =>
  cards.map((card) => `${String(card.rank)}${card.suit}`).join(' ');

describe('createSeedRng', () => {
  it('deals the same deck for the same seed, every time', () => {
    const once = shuffle(createDeck(), createSeedRng(SEED_A));
    const twice = shuffle(createDeck(), createSeedRng(SEED_A));

    expect(asText(once)).toBe(asText(twice));
  });

  it('deals a different deck for a different seed', () => {
    expect(asText(shuffle(createDeck(), createSeedRng(SEED_A)))).not.toBe(
      asText(shuffle(createDeck(), createSeedRng(SEED_B))),
    );
  });

  it('produces exactly these decks, and must go on producing them', () => {
    // Pinned. See the note at the top of this file before touching them.
    expect(asText(shuffle(createDeck(), createSeedRng(SEED_A)).slice(0, 8))).toBe(
      '3s 12d 3c 7d 11c 2h 7c 12s',
    );
    expect(asText(shuffle(createDeck(), createSeedRng(SEED_B)).slice(0, 8))).toBe(
      '6c 9c 10d 14s 12h 2s 10c 2c',
    );
  });

  it('uses the whole seed, not a folded-down piece of it', () => {
    // Two seeds differing only in the last byte have to give unrelated decks.
    const base = 'ab'.repeat(31);
    const one = asText(shuffle(createDeck(), createSeedRng(`${base}00`)));
    const other = asText(shuffle(createDeck(), createSeedRng(`${base}01`)));

    expect(one).not.toBe(other);
  });

  it('is uniform enough that no card favours the top of the deck', () => {
    // 52 positions, 5,200 shuffles: every card should land first about a
    // hundred times. A generator quietly biased by modulo would show up here.
    const firsts = new Map<string, number>();
    for (let i = 0; i < 5_200; i += 1) {
      const seed = i.toString(16).padStart(64, '0');
      const [top] = shuffle(createDeck(), createSeedRng(seed));
      if (!top) throw new Error('empty deck');
      const key = `${String(top.rank)}${top.suit}`;
      firsts.set(key, (firsts.get(key) ?? 0) + 1);
    }

    expect(firsts.size).toBe(52);
    for (const count of firsts.values()) {
      expect(count).toBeGreaterThan(50);
      expect(count).toBeLessThan(160);
    }
  });

  it('refuses a seed that is not hex', () => {
    expect(() => createSeedRng('nonsense')).toThrow(/hex/);
    expect(() => createSeedRng('abc')).toThrow(/hex/);
    expect(() => createSeedRng('')).toThrow(/empty/);
  });
});

describe('planDeal', () => {
  it('deals to the button’s left, one card at a time, twice round', () => {
    const deck = createDeck();
    const dealt = planDeal({
      deck,
      seatCount: 6,
      buttonSeat: 0,
      dealtInSeats: [0, 1, 2],
      boardSize: 5,
    });

    expect(dealt.holeCards.map((hand) => hand.seatIndex)).toEqual([1, 2, 0]);
    // Seat 1 takes the first card and the fourth, not the first two.
    expect(dealt.holeCards[0]?.cards).toEqual([deck[0], deck[3]]);
    expect(dealt.holeCards[1]?.cards).toEqual([deck[1], deck[4]]);
    expect(dealt.holeCards[2]?.cards).toEqual([deck[2], deck[5]]);
    expect(dealt.board).toEqual(deck.slice(6, 11));
  });

  it('skips the seats that were not dealt in', () => {
    expect(dealOrder(9, 4, [0, 4, 7])).toEqual([7, 0, 4]);
  });

  it('agrees with the hand the reducer actually deals', () => {
    // The claim the fairness endpoint rests on: replaying a deal from the deck
    // a seed produces gives the cards the engine really put in front of people.
    const seed = 'c0ffee'.padEnd(64, '0');
    const state = dealHand(tableWith([1000, 1000, 1000]), 'h1', createSeedRng(seed));

    const dealt = planDeal({
      deck: shuffle(createDeck(), createSeedRng(seed)),
      seatCount: state.seats.length,
      buttonSeat: state.buttonSeat ?? 0,
      dealtInSeats: state.dealtInSeats,
      boardSize: 0,
    });

    expect(dealt.holeCards).not.toHaveLength(0);
    for (const hand of dealt.holeCards) {
      expect(asText(seatAt(state, hand.seatIndex).holeCards)).toBe(asText(hand.cards));
    }
  });

  it('agrees with the board the reducer actually deals', () => {
    const seed = 'facade'.padEnd(64, '0');
    const dealt = dealHand(tableWith([1000, 1000, 1000]), 'h1', createSeedRng(seed));
    const state = checkItDown(dealt, seed);

    const plan = planDeal({
      deck: shuffle(createDeck(), createSeedRng(seed)),
      seatCount: state.seats.length,
      buttonSeat: dealt.buttonSeat ?? 0,
      dealtInSeats: dealt.dealtInSeats,
      boardSize: 5,
    });

    expect(state.board).toHaveLength(5);
    expect(asText(state.board)).toBe(asText(plan.board));
  });
});

/** Check when checking is free, call when it is not, until the river is out. */
function checkItDown(from: TableState, seed: string): TableState {
  let state = from;

  for (let step = 0; step < 60 && state.board.length < 5; step += 1) {
    const rng = createSeedRng(seed);
    if (state.toActSeat === null) {
      state = run(state, [advance], rng);
      continue;
    }
    const seat = seatAt(state, state.toActSeat);
    state = run(
      state,
      [
        seat.committedThisRound === state.currentBet
          ? act.check(state.toActSeat)
          : act.call(state.toActSeat),
      ],
      rng,
    );
  }

  return state;
}
