import type { Pot, Seat } from './types';

/**
 * Build the pot layers from what every seat has committed this hand.
 *
 * Pots are derived, never accumulated: given the same commitments you get the
 * same pots, so there is no running total to drift out of step with the stacks.
 *
 * A side pot only exists because someone ran out of chips, so the layer
 * boundaries are the distinct commitments of the all-in seats, ascending. Each
 * layer takes what every seat paid between the previous boundary and this one,
 * and is owed to the seats that paid in full up to it and have not folded.
 * Whatever sits above the highest all-in is one last layer for the seats still
 * betting. Adjacent layers owed to the same seats are merged, because splitting
 * them would make no difference to anyone.
 *
 * A folded seat's chips stay where they are — the pot keeps them — but a folded
 * seat is never eligible for any layer.
 */
export function buildPots(seats: readonly (Seat | null)[]): Pot[] {
  const contributors = seats.filter(
    (seat): seat is Seat => seat !== null && seat.committedThisHand > 0,
  );
  if (contributors.length === 0) return [];

  const allInLevels = [
    ...new Set(
      contributors.filter((seat) => seat.status === 'allin').map((seat) => seat.committedThisHand),
    ),
  ].sort((a, b) => a - b);

  const highestCommitment = Math.max(...contributors.map((seat) => seat.committedThisHand));
  const boundaries = [...allInLevels];
  const topAllIn = allInLevels[allInLevels.length - 1] ?? 0;
  if (highestCommitment > topAllIn) boundaries.push(highestCommitment);

  const pots: Pot[] = [];
  let previousLevel = 0;
  let carry = 0;

  for (const level of boundaries) {
    let amount = carry;
    carry = 0;
    for (const seat of contributors) {
      amount += Math.max(0, Math.min(seat.committedThisHand, level) - previousLevel);
    }

    // A layer capped by an all-in belongs to the seats that paid it in full: a
    // seat cannot win chips it could not cover. The layer above the last all-in
    // has no such cap, so everyone still in who paid into it can win it — which
    // is what keeps the pot whole when a hand ends before the bets are level.
    const isTopLayer = level > topAllIn;
    const eligibleSeats = contributors
      .filter(
        (seat) =>
          seat.status !== 'folded' &&
          (isTopLayer ? seat.committedThisHand > previousLevel : seat.committedThisHand >= level),
      )
      .map((seat) => seat.seatIndex);

    previousLevel = level;
    if (amount === 0) continue;

    if (eligibleSeats.length === 0) {
      // Only a folded seat reached this far — an uncalled bet somebody walked
      // away from. Nobody can win a layer of their own, so the chips drop into
      // the layer below, or wait for the next one that has a live seat in it.
      const previous = pots[pots.length - 1];
      if (previous) {
        pots[pots.length - 1] = {
          amount: previous.amount + amount,
          eligibleSeats: previous.eligibleSeats,
        };
      } else {
        carry = amount;
      }
      continue;
    }

    const previous = pots[pots.length - 1];
    if (previous && sameSeats(previous.eligibleSeats, eligibleSeats)) {
      pots[pots.length - 1] = {
        amount: previous.amount + amount,
        eligibleSeats: previous.eligibleSeats,
      };
    } else {
      pots.push({ amount, eligibleSeats });
    }
  }

  if (carry > 0) {
    // Every contributor folded, which only a hand nobody stayed in can produce.
    pots.push({ amount: carry, eligibleSeats: [] });
  }

  return pots;
}

export function totalPot(pots: readonly Pot[]): number {
  return pots.reduce((sum, pot) => sum + pot.amount, 0);
}

function sameSeats(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
