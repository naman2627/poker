/**
 * Hand evaluation: the category, the kickers, and the exact ordering between
 * two hands of the same category.
 */
import { describe, expect, it } from 'vitest';
import {
  compareHands,
  createCombinatorialEvaluator,
  createDeck,
  defaultEvaluator,
  evaluate5,
  evaluate7,
  HAND_CATEGORIES,
  type HandValue,
} from '../src/index';
import { cards } from './helpers';

const five = (text: string): HandValue => evaluate5(cards(text));
const seven = (text: string): HandValue => evaluate7(cards(text));

describe('evaluate5 categories', () => {
  it.each([
    ['As Ks Qs Js Ts', 'STRAIGHT_FLUSH', 'Royal flush'],
    ['9h 8h 7h 6h 5h', 'STRAIGHT_FLUSH', 'Straight flush, nine high'],
    ['5c 4c 3c 2c Ac', 'STRAIGHT_FLUSH', 'Straight flush, five high'],
    ['7s 7h 7d 7c 2s', 'QUADS', 'Four of a kind, sevens'],
    ['Ks Kh Kd 3c 3s', 'FULL_HOUSE', 'Full house, kings full of threes'],
    ['Ad Jd 8d 5d 2d', 'FLUSH', 'Flush, ace high'],
    ['9c 8s 7h 6d 5c', 'STRAIGHT', 'Straight, nine high'],
    ['Ah 5s 4d 3c 2h', 'STRAIGHT', 'Straight, five high'],
    ['Qs Qh Qd 9c 4s', 'TRIPS', 'Three of a kind, queens'],
    ['Ts Th 4d 4c Ks', 'TWO_PAIR', 'Two pair, tens and fours'],
    ['6s 6h Ad Qc 3s', 'PAIR', 'Pair of sixes'],
    ['Ah Qd 9s 6c 3h', 'HIGH_CARD', 'Ace high'],
  ])('reads %s as %s', (hand, category, name) => {
    const value = five(hand);
    expect(value.category).toBe(category);
    expect(value.name).toBe(name);
  });

  it('orders the categories exactly as they are listed', () => {
    const examples = [
      'Ah Qd 9s 6c 3h',
      '6s 6h Ad Qc 3h',
      'Ts Th 4d 4c Ks',
      'Qs Qh Qd 9c 4s',
      '9c 8s 7h 6d 5c',
      'Ad Jd 8d 5d 2d',
      'Ks Kh Kd 3c 3s',
      '7s 7h 7d 7c 2s',
      '9h 8h 7h 6h 5h',
    ].map(five);

    expect(examples.map((value) => value.category)).toEqual([...HAND_CATEGORIES]);
    for (let i = 1; i < examples.length; i += 1) {
      const stronger = examples[i];
      const weaker = examples[i - 1];
      if (!stronger || !weaker) throw new Error('missing example');
      expect(compareHands(stronger, weaker)).toBeGreaterThan(0);
    }
  });
});

describe('the wheel', () => {
  it('is a straight, and beats a pair', () => {
    const wheel = five('Ah 5s 4d 3c 2h');

    expect(wheel.category).toBe('STRAIGHT');
    expect(wheel.ranks).toEqual([5]);
    expect(compareHands(wheel, five('As Ad 9s 6c 3h'))).toBeGreaterThan(0);
  });

  it('loses to a six-high straight, the next one up', () => {
    expect(compareHands(five('Ah 5s 4d 3c 2h'), five('6s 5c 4h 3d 2c'))).toBeLessThan(0);
  });

  it('is the weakest straight there is', () => {
    const wheel = five('Ah 5s 4d 3c 2h');
    const sixHigh = five('6s 5c 4h 3d 2c');

    expect(wheel.score).toBeLessThan(sixHigh.score);
    // The ace plays low here and nowhere else: it is not an ace-high straight.
    expect(compareHands(wheel, five('Ah Ks Qd Jc Th'))).toBeLessThan(0);
  });

  it('is found inside seven cards', () => {
    const value = seven('Ah 2h 3s 4d 5c Kd Qc');

    expect(value.category).toBe('STRAIGHT');
    expect(value.name).toBe('Straight, five high');
  });

  it('gives way to a wheel flush', () => {
    const value = seven('Ah 2h 3h 4h 5h Kd Qc');

    expect(value.category).toBe('STRAIGHT_FLUSH');
    expect(value.name).toBe('Straight flush, five high');
  });
});

describe('kickers', () => {
  it('separates two hands with the same pair', () => {
    expect(compareHands(five('9s 9h Ad 7c 4s'), five('9s 9h Kd 7c 4s'))).toBeGreaterThan(0);
  });

  it('goes all the way to the last kicker', () => {
    expect(compareHands(five('9s 9h Ad 7c 5s'), five('9s 9h Ad 7c 4s'))).toBeGreaterThan(0);
  });

  it('calls identical ranks a tie whatever the suits', () => {
    const a = five('9s 9h Ad 7c 4s');
    const b = five('9d 9c Ah 7s 4h');

    expect(compareHands(a, b)).toBe(0);
    expect(a.score).toBe(b.score);
  });

  it('ranks two pair by the top pair, then the second, then the kicker', () => {
    const topPair = five('Ks Kh 3d 3c 2s');
    const secondPair = five('Qs Qh Jd Jc 2s');
    expect(compareHands(topPair, secondPair)).toBeGreaterThan(0);

    expect(compareHands(five('Ks Kh 4d 4c 2s'), five('Ks Kh 3d 3c As'))).toBeGreaterThan(0);
    expect(compareHands(five('Ks Kh 3d 3c As'), five('Ks Kh 3d 3c Qs'))).toBeGreaterThan(0);
  });

  it('ranks a full house by the trips before the pair', () => {
    expect(compareHands(five('9s 9h 9d 2c 2s'), five('8s 8h 8d As Ah'))).toBeGreaterThan(0);
    expect(compareHands(five('9s 9h 9d As Ah'), five('9s 9h 9d 2c 2s'))).toBeGreaterThan(0);
  });

  it('ranks quads by the kicker when the quads match', () => {
    expect(compareHands(five('7s 7h 7d 7c As'), five('7s 7h 7d 7c Ks'))).toBeGreaterThan(0);
  });

  it('ranks a flush card by card', () => {
    expect(compareHands(five('Ad Jd 8d 5d 2d'), five('Ad Jd 8d 4d 3d'))).toBeGreaterThan(0);
  });

  it('exposes the tiebreakers in comparison order', () => {
    expect(five('Ks Kh 4d 4c 2s').ranks).toEqual([13, 4, 2]);
    expect(five('Qs Qh Qd 9c 4s').ranks).toEqual([12, 9, 4]);
    expect(five('7s 7h 7d 7c As').ranks).toEqual([7, 14]);
    expect(five('Ah Qd 9s 6c 3h').ranks).toEqual([14, 12, 9, 6, 3]);
  });
});

describe('evaluate7', () => {
  it('picks the best five of the seven', () => {
    // Two pair are there for the taking, but five diamonds beat them.
    const value = seven('Ad Kd 9d 9s 4d 4s 2d');

    expect(value.category).toBe('FLUSH');
    expect(value.name).toBe('Flush, ace high');
  });

  it('finds the full house hiding behind a two pair board', () => {
    const value = seven('9s 9h 4d 4c 4s Kd 2h');

    expect(value.category).toBe('FULL_HOUSE');
    expect(value.name).toBe('Full house, fours full of nines');
  });

  it('never misses a straight that spans the hole cards and the board', () => {
    const value = seven('8h 7c Ks 6d 5s 4h 2c');

    expect(value.category).toBe('STRAIGHT');
    expect(value.name).toBe('Straight, eight high');
  });

  it('takes the higher of two straights the same seven cards make', () => {
    expect(seven('9c 8s 7h 6d 5c 4h 3s').ranks).toEqual([9]);
  });

  it('plays the board when the hole cards add nothing', () => {
    const board = 'As Ks Qs Js Ts';
    const withJunk = seven(`2h 3c ${board}`);
    const withOtherJunk = seven(`4d 6c ${board}`);

    expect(withJunk.name).toBe('Royal flush');
    expect(compareHands(withJunk, withOtherJunk)).toBe(0);
  });

  it('agrees with evaluate5 when the extra two cards are worthless', () => {
    expect(seven('Ks Kh Kd 3c 3s 2h 4d')).toEqual(five('Ks Kh Kd 3c 3s'));
  });

  it('does not care what order the cards arrive in', () => {
    expect(seven('Ad Kd 9d 9s 4d 4s 2d')).toEqual(seven('2d 4s 4d 9s 9d Kd Ad'));
  });

  it('refuses anything that is not seven cards', () => {
    expect(() => evaluate7(cards('Ad Kd 9d 9s 4d 4s'))).toThrow(/exactly 7 cards/);
    expect(() => evaluate5(cards('Ad Kd 9d 9s'))).toThrow(/exactly 5 cards/);
  });
});

describe('the HandEvaluator interface', () => {
  it('is what the default is built from', () => {
    const swapped = createCombinatorialEvaluator();
    const hand = cards('Ks Kh Kd 3c 3s 2h 4d');

    expect(swapped.evaluate7(hand)).toEqual(defaultEvaluator.evaluate7(hand));
  });

  it('compares through the same score the value carries', () => {
    const better = five('Ks Kh Kd 3c 3s');
    const worse = five('9s 9h Ad 7c 4s');

    expect(defaultEvaluator.compare(better, worse)).toBe(better.score - worse.score);
    expect(defaultEvaluator.compare(worse, better)).toBeLessThan(0);
    expect(defaultEvaluator.compare(better, better)).toBe(0);
  });

  it('scores every hand in the deck as a safe integer', () => {
    const deck = createDeck();
    const first = deck[0];
    const second = deck[13];
    const third = deck[26];
    if (!first || !second || !third) throw new Error('short deck');

    const value = defaultEvaluator.evaluate7([first, second, third, ...cards('7h 2c 5d 9s')]);

    expect(Number.isSafeInteger(value.score)).toBe(true);
    expect(value.score).toBeGreaterThan(0);
  });
});
