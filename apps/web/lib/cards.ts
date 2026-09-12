import type { Card, Suit } from '@poker/shared';

/**
 * How a card reads. Nothing here decides anything about a hand — rank order for
 * *play* is the engine's business (CLAUDE.md §2); this is typography.
 */
const RANK_LABELS: Readonly<Record<number, string>> = {
  2: '2',
  3: '3',
  4: '4',
  5: '5',
  6: '6',
  7: '7',
  8: '8',
  9: '9',
  10: '10',
  11: 'J',
  12: 'Q',
  13: 'K',
  14: 'A',
};

const SUIT_GLYPHS: Readonly<Record<Suit, string>> = {
  s: '♠',
  h: '♥',
  d: '♦',
  c: '♣',
};

const SUIT_NAMES: Readonly<Record<Suit, string>> = {
  s: 'spades',
  h: 'hearts',
  d: 'diamonds',
  c: 'clubs',
};

/**
 * Spoken form. Every rank is a word, including the pip cards: this text is read
 * aloud in the live region *and* shown as prose in the hand log, and "the flop:
 * king of spades, 9 of hearts" reads as a mix of two registers in the second.
 */
const RANK_NAMES: Readonly<Record<number, string>> = {
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

export function rankLabel(rank: number): string {
  return RANK_LABELS[rank] ?? String(rank);
}

export function suitGlyph(suit: Suit): string {
  return SUIT_GLYPHS[suit];
}

export function isRedSuit(suit: Suit): boolean {
  return suit === 'h' || suit === 'd';
}

/** What a screen reader says instead of "A♠". */
export function cardLabel(card: Card): string {
  return `${RANK_NAMES[card.rank] ?? String(card.rank)} of ${SUIT_NAMES[card.suit]}`;
}

export function cardKey(card: Card): string {
  return `${String(card.rank)}${card.suit}`;
}
