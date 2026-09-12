/**
 * Turning final pots into chips.
 *
 * This is where the evaluator meets the pot layers: each layer goes to the best
 * hand among the seats eligible for it, ties split it, and odd chips go to the
 * seat closest to the left of the button — the same seat that would be dealt to
 * first, which is how a live game breaks a chip that will not divide.
 */
import { fail } from './errors';
import {
  defaultEvaluator,
  type HandCategory,
  type HandEvaluator,
  type HandValue,
} from './hand-eval';
import { liveSeats, seatsClockwiseFrom } from './seating';
import type { Card, Seat, TableState } from './types';

export interface PotAward {
  readonly seatIndex: number;
  readonly amount: number;
  /** Index into the pots this award came from, main pot first. */
  readonly potIndex: number;
}

export interface HandReveal {
  readonly seatIndex: number;
  readonly cards: readonly Card[];
  readonly handName: string;
  /** The same hand as a comparable category, beside the readable name. */
  readonly category: HandCategory;
  /** Position in the showdown order: 0 shows first. */
  readonly order: number;
}

export interface ShowdownResult {
  readonly awards: readonly PotAward[];
  /** The hands that were turned over, in the order they were shown. */
  readonly revealed: readonly HandReveal[];
  /** Seats that reached the showdown and did not have to show. */
  readonly mucked: readonly { readonly seatIndex: number; readonly order: number }[];
}

/**
 * Who shows, and in what order.
 *
 * The order is the table's, not the seat numbering's: the last player to bet or
 * raise on the final street has to turn over first, and if nobody bet, the first
 * live seat to the button's left does. Everyone else follows clockwise.
 *
 * Then, in that order, a hand is shown when it has something to prove and
 * mucked when it does not:
 *
 *   - the first player in the order always shows; they were asked to
 *   - anyone whose hand beats everything shown so far shows, because they are
 *     still live for something
 *   - anyone who wins a pot shows — a short all-in can lose the side pot to a
 *     hand already face up and still take the main
 *
 * Everybody else mucks, and a mucked hand stays private: it is never in a
 * `HAND_REVEALED`, never in `revealed`, and never leaves the server unless its
 * owner later asks to show it.
 */
export function showdownOrder(state: TableState): number[] {
  const live = liveSeats(state).map((seat) => seat.seatIndex);
  if (live.length === 0) return [];

  const first =
    state.lastAggressorSeat !== null && live.includes(state.lastAggressorSeat)
      ? state.lastAggressorSeat
      : firstLiveLeftOfButton(state, live);

  const rest = seatsClockwiseFrom(state.seats.length, first).filter((index) =>
    live.includes(index),
  );
  return [first, ...rest.filter((index) => index !== first)];
}

function firstLiveLeftOfButton(state: TableState, live: readonly number[]): number {
  const fallback = live[0];
  if (fallback === undefined) fail('SEAT_NOT_FOUND', 'a showdown with nobody in it');
  if (state.buttonSeat === null) return fallback;

  for (const index of seatsClockwiseFrom(state.seats.length, state.buttonSeat)) {
    if (live.includes(index)) return index;
  }
  return fallback;
}

/**
 * Resolve `state.pots` against the hands at the table.
 *
 * A pot with a single eligible seat is handed over without anyone showing a
 * card — that is a hand everybody else folded, and there is nothing to compare.
 * Contested pots need five board cards and two hole cards per eligible seat.
 */
export function resolveShowdown(
  state: TableState,
  evaluator: HandEvaluator = defaultEvaluator,
): ShowdownResult {
  const awards: PotAward[] = [];
  const hands = new Map<number, HandValue>();

  let collected = 0;

  state.pots.forEach((pot, potIndex) => {
    const eligible = pot.eligibleSeats.map((seatIndex) => seatOf(state, seatIndex));
    if (eligible.length === 0) {
      // Nobody can win these chips; they are left where they are rather than
      // handed to a seat that has no claim on them.
      return;
    }
    collected += pot.amount;

    const winners =
      eligible.length === 1
        ? eligible
        : bestOf(eligible, (seat) => handOf(state, seat, evaluator, hands));

    for (const award of split(state, pot.amount, winners, potIndex)) awards.push(award);
  });

  const awarded = awards.reduce((sum, award) => sum + award.amount, 0);
  if (awarded !== collected) {
    fail('POT_MISMATCH', `awarded ${String(awarded)} chips from pots holding ${String(collected)}`);
  }

  const shown = decideShown(state, awards, evaluator, hands);
  return { awards, ...shown };
}

/**
 * Walk the showdown order and decide, seat by seat, who turns over.
 *
 * Only reached for a hand that actually got to a showdown: when everybody else
 * folded, `state.pots` has one eligible seat, nothing is compared, and nothing
 * is shown — which is why an uncontested hand never reveals a card.
 */
function decideShown(
  state: TableState,
  awards: readonly PotAward[],
  evaluator: HandEvaluator,
  hands: Map<number, HandValue>,
): { revealed: HandReveal[]; mucked: { seatIndex: number; order: number }[] } {
  const order = showdownOrder(state);
  const contested = state.pots.some((pot) => pot.eligibleSeats.length > 1);
  if (!contested) return { revealed: [], mucked: [] };

  const winners = new Set(awards.map((award) => award.seatIndex));
  const revealed: HandReveal[] = [];
  const mucked: { seatIndex: number; order: number }[] = [];
  let bestShown: number | null = null;

  order.forEach((seatIndex, position) => {
    const seat = seatOf(state, seatIndex);
    if (seat.holeCards.length === 0) return;

    const value = handOf(state, seat, evaluator, hands);
    const mustShow = position === 0 || winners.has(seatIndex) || value.score >= (bestShown ?? -1);

    if (!mustShow) {
      mucked.push({ seatIndex, order: position });
      return;
    }

    bestShown = bestShown === null ? value.score : Math.max(bestShown, value.score);
    revealed.push({
      seatIndex,
      cards: [...seat.holeCards],
      handName: value.name,
      category: value.category,
      order: position,
    });
  });

  return { revealed, mucked };
}

function bestOf(seats: readonly Seat[], valueOf: (seat: Seat) => HandValue): Seat[] {
  let best: HandValue | null = null;
  let winners: Seat[] = [];

  for (const seat of seats) {
    const value = valueOf(seat);
    if (best === null || value.score > best.score) {
      best = value;
      winners = [seat];
    } else if (value.score === best.score) {
      winners.push(seat);
    }
  }

  return winners;
}

function handOf(
  state: TableState,
  seat: Seat,
  evaluator: HandEvaluator,
  hands: Map<number, HandValue>,
): HandValue {
  const cached = hands.get(seat.seatIndex);
  if (cached) return cached;

  const cards = [...seat.holeCards, ...state.board];
  if (cards.length !== 7) {
    fail(
      'INVALID_HAND',
      `seat ${String(seat.seatIndex)} reached a contested showdown with ${String(cards.length)} cards`,
    );
  }

  const value = evaluator.evaluate7(cards);
  hands.set(seat.seatIndex, value);
  return value;
}

/**
 * Split `amount` between the winners. The chips that will not divide go one
 * each to the winners nearest the left of the button.
 */
function split(
  state: TableState,
  amount: number,
  winners: readonly Seat[],
  potIndex: number,
): PotAward[] {
  const order = inOddChipOrder(state, winners);
  const share = Math.floor(amount / order.length);
  const odd = amount % order.length;

  return order
    .map((seat, position) => ({
      seatIndex: seat.seatIndex,
      amount: share + (position < odd ? 1 : 0),
      potIndex,
    }))
    .filter((award) => award.amount > 0);
}

/** Winners ordered from the button's left around the table. */
function inOddChipOrder(state: TableState, winners: readonly Seat[]): Seat[] {
  if (state.buttonSeat === null) {
    return [...winners].sort((a, b) => a.seatIndex - b.seatIndex);
  }

  const clockwise = seatsClockwiseFrom(state.seats.length, state.buttonSeat);
  return [...winners].sort(
    (a, b) => clockwise.indexOf(a.seatIndex) - clockwise.indexOf(b.seatIndex),
  );
}

function seatOf(state: TableState, seatIndex: number): Seat {
  const seat = state.seats[seatIndex];
  if (!seat) fail('SEAT_NOT_FOUND', `pot names seat ${String(seatIndex)}, which is empty`);
  return seat;
}
