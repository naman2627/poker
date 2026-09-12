import { fail } from './errors';
import type { Card } from './types';

/**
 * Where each card off the top of the deck goes.
 *
 * This exists so that the dealer and the auditor cannot disagree. `reduce()`
 * deals from here, and the fairness endpoint replays from here, so "the seed
 * produces the cards that were dealt" is a claim about one function rather than
 * two implementations that happen to match today.
 *
 * The rules it encodes, all of them visible in any live game:
 *
 *   - the deal starts to the button's left and goes clockwise
 *   - two passes, one card each, not two at a time
 *   - the board follows immediately, in order, with no burn cards (see
 *     `deck.ts` for why this deck does not burn)
 */
export interface DealtHand {
  /** Seat index to the two cards it was dealt, in the order it got them. */
  readonly holeCards: readonly { readonly seatIndex: number; readonly cards: readonly Card[] }[];
  readonly board: readonly Card[];
}

/**
 * The seats a deal touches, in the order it touches them: clockwise from the
 * button's left.
 */
export function dealOrder(
  seatCount: number,
  buttonSeat: number,
  dealtInSeats: readonly number[],
): number[] {
  const order: number[] = [];
  for (let step = 1; step <= seatCount; step += 1) {
    const index = (buttonSeat + step) % seatCount;
    if (dealtInSeats.includes(index)) order.push(index);
  }
  return order;
}

export interface DealPlan {
  readonly deck: readonly Card[];
  readonly seatCount: number;
  readonly buttonSeat: number;
  readonly dealtInSeats: readonly number[];
  /** 0, 3, 4 or 5 — however far the hand actually got. */
  readonly boardSize: number;
  readonly cardsPerSeat?: number;
}

/**
 * Deal `plan.deck` out and say what everybody got.
 *
 * Pure arithmetic on an array: no shuffling, no randomness, no state. Hand it
 * the deck a seed produces and it tells you the hand that seed produces.
 */
export function planDeal(plan: DealPlan): DealtHand {
  const perSeat = plan.cardsPerSeat ?? 2;
  const order = dealOrder(plan.seatCount, plan.buttonSeat, plan.dealtInSeats);

  const needed = order.length * perSeat + plan.boardSize;
  if (needed > plan.deck.length) {
    fail(
      'DECK_EXHAUSTED',
      `the deal needs ${String(needed)} cards, the deck has ${String(plan.deck.length)}`,
    );
  }

  const hands = new Map<number, Card[]>(order.map((seatIndex) => [seatIndex, []]));

  let next = 0;
  for (let pass = 0; pass < perSeat; pass += 1) {
    for (const seatIndex of order) {
      const card = plan.deck[next];
      next += 1;
      if (card === undefined) fail('DECK_EXHAUSTED', 'the deck ran out during the deal');
      hands.get(seatIndex)?.push(card);
    }
  }

  return {
    holeCards: order.map((seatIndex) => ({
      seatIndex,
      cards: hands.get(seatIndex) ?? [],
    })),
    board: plan.deck.slice(next, next + plan.boardSize),
  };
}
