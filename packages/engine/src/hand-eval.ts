/**
 * Made-hand evaluation.
 *
 * The default evaluator is the obvious one: to find the best five cards out of
 * seven it looks at all 21 combinations and keeps the highest. That is slower
 * than a lookup table by a wide margin and much easier to be sure about, which
 * is the right trade while the rules are still being written. Everything else
 * talks to it through `HandEvaluator`, so a faster one can be dropped in without
 * touching a single caller.
 */
import { fail } from './errors';
import type { Card, Rank } from './types';

/** Weakest to strongest. The index is the category's rank in a comparison. */
export const HAND_CATEGORIES = [
  'HIGH_CARD',
  'PAIR',
  'TWO_PAIR',
  'TRIPS',
  'STRAIGHT',
  'FLUSH',
  'FULL_HOUSE',
  'QUADS',
  'STRAIGHT_FLUSH',
] as const;

export type HandCategory = (typeof HAND_CATEGORIES)[number];

export interface HandValue {
  readonly category: HandCategory;
  /**
   * The tiebreakers, most significant first, already in comparison order: the
   * pair before its kickers, the trips before the pair in a full house, the top
   * card of a straight on its own. A wheel's high card is the five.
   */
  readonly ranks: readonly Rank[];
  /**
   * The whole hand as one number: category and tiebreakers packed base 15, most
   * significant first. Two hands compare exactly when their scores do, and equal
   * scores mean a genuine tie — so `a.score - b.score` is the whole comparison.
   */
  readonly score: number;
  /** Human-readable, for logs and for the showdown ("Kings full of threes"). */
  readonly name: string;
}

export interface HandEvaluator {
  /** The best five-card hand out of exactly seven cards. */
  evaluate7(cards: readonly Card[]): HandValue;
  /** Negative if `a` loses, positive if `a` wins, zero on an exact tie. */
  compare(a: HandValue, b: HandValue): number;
}

/** Ranks are 2..14, so base 15 leaves 0 free to mean "no tiebreaker here". */
const RANK_BASE = 15;
const MAX_TIEBREAKERS = 5;

/** The 21 ways to choose five cards from seven. */
const FIVE_FROM_SEVEN = combinations(7, 5);

export function createCombinatorialEvaluator(): HandEvaluator {
  return {
    evaluate7(cards: readonly Card[]): HandValue {
      if (cards.length !== 7) {
        fail('INVALID_HAND', `evaluate7 needs exactly 7 cards, got ${String(cards.length)}`);
      }

      let best: HandValue | null = null;
      for (const indexes of FIVE_FROM_SEVEN) {
        const five = indexes.map((index) => {
          const card = cards[index];
          if (card === undefined) fail('INVALID_HAND', 'a card in the hand was missing');
          return card;
        });
        const value = evaluate5(five);
        if (best === null || value.score > best.score) best = value;
      }

      if (best === null) fail('INVALID_HAND', 'no five-card hand could be made');
      return best;
    },

    compare(a: HandValue, b: HandValue): number {
      return a.score - b.score;
    },
  };
}

export const defaultEvaluator: HandEvaluator = createCombinatorialEvaluator();

/** The best five-card hand out of seven, using the default evaluator. */
export function evaluate7(cards: readonly Card[]): HandValue {
  return defaultEvaluator.evaluate7(cards);
}

/** Rank a single five-card hand. Exported because it is worth testing directly. */
export function evaluate5(cards: readonly Card[]): HandValue {
  if (cards.length !== 5) {
    fail('INVALID_HAND', `evaluate5 needs exactly 5 cards, got ${String(cards.length)}`);
  }

  const ranks = cards.map((card) => card.rank).sort((a, b) => b - a);
  const firstSuit = cards[0]?.suit;
  const isFlush = firstSuit !== undefined && cards.every((card) => card.suit === firstSuit);

  // Ranks grouped by how many of each there are: quads first, then trips, then
  // pairs, each group ordered by rank. That ordering is exactly the tiebreak
  // order for every paired category.
  const counts = new Map<Rank, number>();
  for (const rank of ranks) counts.set(rank, (counts.get(rank) ?? 0) + 1);
  const groups = [...counts.entries()].sort(
    ([rankA, countA], [rankB, countB]) => countB - countA || rankB - rankA,
  );
  const grouped = groups.map(([rank]) => rank);
  const shape = groups.map(([, count]) => count);

  const straightHigh = straightHighOf(ranks);

  if (isFlush && straightHigh !== null) return handValue('STRAIGHT_FLUSH', [straightHigh]);
  if (shape[0] === 4) return handValue('QUADS', grouped.slice(0, 2));
  if (shape[0] === 3 && shape[1] === 2) return handValue('FULL_HOUSE', grouped.slice(0, 2));
  if (isFlush) return handValue('FLUSH', ranks);
  if (straightHigh !== null) return handValue('STRAIGHT', [straightHigh]);
  if (shape[0] === 3) return handValue('TRIPS', grouped.slice(0, 3));
  if (shape[0] === 2 && shape[1] === 2) return handValue('TWO_PAIR', grouped.slice(0, 3));
  if (shape[0] === 2) return handValue('PAIR', grouped.slice(0, 4));
  return handValue('HIGH_CARD', ranks);
}

/** Negative if `a` loses, positive if `a` wins, zero on an exact tie. */
export function compareHands(a: HandValue, b: HandValue): number {
  return a.score - b.score;
}

/**
 * The top card of a straight, or null. The ace plays low as well as high, so
 * A-2-3-4-5 — the wheel — is a straight to the five and the weakest one there is.
 */
function straightHighOf(ranksDesc: readonly Rank[]): Rank | null {
  const distinct = [...new Set(ranksDesc)];
  if (distinct.length !== 5) return null;

  const [high, second, third, fourth, low] = distinct;
  if (high === undefined || low === undefined) return null;
  if (high - low === 4) return high;

  // The wheel: an ace, then 5-4-3-2.
  if (high === 14 && second === 5 && third === 4 && fourth === 3 && low === 2) return 5;
  return null;
}

function handValue(category: HandCategory, ranks: readonly Rank[]): HandValue {
  return {
    category,
    ranks,
    score: scoreOf(category, ranks),
    name: nameOf(category, ranks),
  };
}

/** Category and tiebreakers packed into one integer, most significant first. */
function scoreOf(category: HandCategory, ranks: readonly Rank[]): number {
  let score = HAND_CATEGORIES.indexOf(category);
  for (let slot = 0; slot < MAX_TIEBREAKERS; slot += 1) {
    score = score * RANK_BASE + (ranks[slot] ?? 0);
  }
  return score;
}

function nameOf(category: HandCategory, ranks: readonly Rank[]): string {
  const [first, second] = ranks;
  switch (category) {
    case 'STRAIGHT_FLUSH':
      return first === 14 ? 'Royal flush' : `Straight flush, ${rankWord(first)} high`;
    case 'QUADS':
      return `Four of a kind, ${pluralWord(first)}`;
    case 'FULL_HOUSE':
      return `Full house, ${pluralWord(first)} full of ${pluralWord(second)}`;
    case 'FLUSH':
      return `Flush, ${rankWord(first)} high`;
    case 'STRAIGHT':
      return `Straight, ${rankWord(first)} high`;
    case 'TRIPS':
      return `Three of a kind, ${pluralWord(first)}`;
    case 'TWO_PAIR':
      return `Two pair, ${pluralWord(first)} and ${pluralWord(second)}`;
    case 'PAIR':
      return `Pair of ${pluralWord(first)}`;
    case 'HIGH_CARD':
      return `${capitalize(rankWord(first))} high`;
  }
}

const RANK_WORDS: Readonly<Record<number, string>> = {
  2: 'two',
  3: 'three',
  4: 'four',
  5: 'five',
  6: 'six',
  7: 'seven',
  8: 'eight',
  9: 'nine',
  10: 'ten',
  11: 'jack',
  12: 'queen',
  13: 'king',
  14: 'ace',
};

const PLURAL_WORDS: Readonly<Record<number, string>> = {
  2: 'twos',
  3: 'threes',
  4: 'fours',
  5: 'fives',
  6: 'sixes',
  7: 'sevens',
  8: 'eights',
  9: 'nines',
  10: 'tens',
  11: 'jacks',
  12: 'queens',
  13: 'kings',
  14: 'aces',
};

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function rankWord(rank: Rank | undefined): string {
  return rank === undefined ? 'unknown' : (RANK_WORDS[rank] ?? String(rank));
}

function pluralWord(rank: Rank | undefined): string {
  return rank === undefined ? 'unknown' : (PLURAL_WORDS[rank] ?? `${String(rank)}s`);
}

/** Every way to choose `choose` indexes out of `total`, in ascending order. */
function combinations(total: number, choose: number): readonly (readonly number[])[] {
  const out: number[][] = [];
  const current: number[] = [];

  const walk = (start: number): void => {
    if (current.length === choose) {
      out.push([...current]);
      return;
    }
    for (let index = start; index < total; index += 1) {
      current.push(index);
      walk(index + 1);
      current.pop();
    }
  };

  walk(0);
  return out;
}
