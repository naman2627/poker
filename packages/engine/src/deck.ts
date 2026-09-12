import { fail } from './errors';
import type { Rng } from './rng';
import { RANKS, SUITS, type Card } from './types';

/**
 * A fresh 52-card deck in a fixed order: spades, hearts, diamonds, clubs, each
 * from 2 to ace. The order only matters as the input to the shuffle — it must be
 * the same every time so a seeded shuffle is reproducible.
 */
export function createDeck(): Card[] {
  const deck: Card[] = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ rank, suit });
    }
  }
  return deck;
}

/**
 * Fisher-Yates, walking from the back, taking every index from the injected Rng.
 * Returns a new array; the input is untouched.
 *
 * There are no burn cards anywhere in this engine. Burning protects against
 * marked cards and glimpsed backs at a physical table; with a shuffle this deck
 * never leaves the server it buys nothing and only makes the deal harder to
 * audit.
 */
export function shuffle(cards: readonly Card[], rng: Rng): Card[] {
  const out = [...cards];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = rng.int(i + 1);
    const a = out[i];
    const b = out[j];
    if (a === undefined || b === undefined) {
      fail('DECK_EXHAUSTED', `shuffle went out of bounds at ${String(i)}/${String(j)}`);
    }
    out[i] = b;
    out[j] = a;
  }
  return out;
}
