import { describe, expect, it } from 'vitest';
import { createDeck, createRngFrom, seededRng, shuffle } from '../src/index';

describe('createDeck', () => {
  it('is 52 distinct cards', () => {
    const deck = createDeck();
    const keys = new Set(deck.map((card) => `${String(card.rank)}${card.suit}`));

    expect(deck).toHaveLength(52);
    expect(keys.size).toBe(52);
  });

  it('holds thirteen ranks in each of four suits', () => {
    const deck = createDeck();
    for (const suit of ['s', 'h', 'd', 'c'] as const) {
      expect(deck.filter((card) => card.suit === suit)).toHaveLength(13);
    }
    expect(deck.filter((card) => card.rank === 14)).toHaveLength(4);
  });

  it('always starts in the same order, so a seeded shuffle is reproducible', () => {
    expect(createDeck()).toEqual(createDeck());
  });
});

describe('shuffle', () => {
  it('leaves the input untouched', () => {
    const deck = createDeck();
    const before = [...deck];
    shuffle(deck, seededRng('a'));

    expect(deck).toEqual(before);
  });

  it('keeps all 52 cards', () => {
    const shuffled = shuffle(createDeck(), seededRng('a'));
    const keys = new Set(shuffled.map((card) => `${String(card.rank)}${card.suit}`));

    expect(shuffled).toHaveLength(52);
    expect(keys.size).toBe(52);
  });

  it('gives the same order for the same seed and a different one for another', () => {
    expect(shuffle(createDeck(), seededRng('a'))).toEqual(shuffle(createDeck(), seededRng('a')));
    expect(shuffle(createDeck(), seededRng('a'))).not.toEqual(
      shuffle(createDeck(), seededRng('b')),
    );
  });

  it('asks the rng for one index per card, each bounded by the cards left', () => {
    const bounds: number[] = [];
    const rng = createRngFrom((maxExclusive) => {
      bounds.push(maxExclusive);
      return 0;
    });
    shuffle(createDeck(), rng);

    expect(bounds).toHaveLength(51);
    expect(bounds[0]).toBe(52);
    expect(bounds[bounds.length - 1]).toBe(2);
  });

  it('is a real permutation even when the rng always answers 0', () => {
    const shuffled = shuffle(
      createDeck(),
      createRngFrom(() => 0),
    );
    const keys = new Set(shuffled.map((card) => `${String(card.rank)}${card.suit}`));

    expect(keys.size).toBe(52);
    expect(shuffled).not.toEqual(createDeck());
  });
});
