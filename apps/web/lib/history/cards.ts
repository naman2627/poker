import type { Card, Suit } from '@poker/shared';

/**
 * Turning a stored card code back into a card.
 *
 * The record keeps cards as `Ks` and `10h` — legible in a database column, and
 * one string rather than two columns. The felt draws `Card` objects, so this is
 * the seam between them.
 */
export function parseCardCode(code: string): Card | null {
  const match = /^(10|1[1-4]|[2-9])([shdc])$/.exec(code);
  if (!match) return null;

  const [, rank, suit] = match;
  if (rank === undefined || suit === undefined) return null;

  return { rank: Number(rank), suit: suit as Suit };
}

export function parseCardCodes(codes: readonly string[]): Card[] {
  return codes.flatMap((code) => {
    const card = parseCardCode(code);
    return card === null ? [] : [card];
  });
}
