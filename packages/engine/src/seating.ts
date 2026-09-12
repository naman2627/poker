import type { Seat, TableState } from './types';

/** Every occupied seat, in seat order. */
export function occupiedSeats(state: TableState): Seat[] {
  return state.seats.filter((seat): seat is Seat => seat !== null);
}

/** Seats that were dealt into the current hand and have not folded. */
export function liveSeats(state: TableState): Seat[] {
  return occupiedSeats(state).filter((seat) => seat.status === 'active' || seat.status === 'allin');
}

/** Seats that can still put chips in: in the hand, with chips left. */
export function actingSeats(state: TableState): Seat[] {
  return occupiedSeats(state).filter((seat) => seat.status === 'active');
}

/**
 * Seat indices clockwise from `from`, exclusive, wrapping once around the table.
 * Seat order *is* table order: seat 0 is left of the highest-numbered seat.
 */
export function seatsClockwiseFrom(seatCount: number, from: number): number[] {
  const order: number[] = [];
  for (let step = 1; step <= seatCount; step += 1) {
    order.push((from + step) % seatCount);
  }
  return order;
}

/** The first index at or after `from` + 1 that is in `candidates`, or null. */
export function nextIn(
  seatCount: number,
  from: number,
  candidates: readonly number[],
): number | null {
  for (const index of seatsClockwiseFrom(seatCount, from)) {
    if (candidates.includes(index)) return index;
  }
  return null;
}

/**
 * The first seat clockwise from `from` that satisfies `predicate`. `from` itself
 * is checked last, so passing a seat that qualifies returns that seat only when
 * nobody else does.
 */
export function nextSeatWhere(
  state: TableState,
  from: number,
  predicate: (seat: Seat) => boolean,
): number | null {
  for (const index of seatsClockwiseFrom(state.seats.length, from)) {
    const seat = state.seats[index];
    if (seat && predicate(seat)) return index;
  }
  return null;
}
