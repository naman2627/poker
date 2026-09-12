/**
 * @poker/engine — the poker rules, as pure functions.
 *
 * Constraints that must hold for every file in this package:
 *   - no I/O, no network, no timers, no logging
 *   - no Node built-ins except `node:crypto`, and only inside rng.ts
 *   - no ambient randomness: callers pass an `Rng`
 *   - same inputs, same outputs, every time
 *
 * The surface is small on purpose: build a table, feed it commands, read the
 * state and events back out.
 *
 *   const table = createTable({ seatCount: 6, smallBlind: 5, bigBlind: 10 });
 *   const { state, events } = reduce(table, { type: 'START_HAND', handId }, rng);
 *
 * Reaching `payout` resolves the showdown: pots are built from what each seat
 * committed, compared with the `HandEvaluator`, and paid out — split evenly on a
 * tie, with odd chips going to the seat left of the button.
 */
export type { Rng } from './rng';
export { createCryptoRng, cryptoRng, createRngFrom, createSeedRng, seededRng } from './rng';

export { createDeck, shuffle } from './deck';
export { dealOrder, planDeal, type DealPlan, type DealtHand } from './deal';
export { buildPots, totalPot } from './pots';
export {
  HAND_CATEGORIES,
  compareHands,
  createCombinatorialEvaluator,
  defaultEvaluator,
  evaluate5,
  evaluate7,
  type HandCategory,
  type HandEvaluator,
  type HandValue,
} from './hand-eval';
export { resolveShowdown, type HandReveal, type PotAward, type ShowdownResult } from './showdown';
export { legalActions, isBettingRoundComplete, isBettingStreet } from './legal-actions';
export { actingSeats, liveSeats, occupiedSeats, seatsClockwiseFrom } from './seating';
export { reduce, createTable } from './reduce';
export { EngineError, type EngineErrorCode } from './errors';

export {
  RANKS,
  SUITS,
  STREETS,
  type Card,
  type Command,
  type CommandType,
  type EngineEvent,
  type EngineEventType,
  type LegalActions,
  type Phase,
  type PlayerActionInput,
  type PlayerActionType,
  type Pot,
  type Rank,
  type ReduceResult,
  type Seat,
  type SeatStatus,
  type Street,
  type Suit,
  type TableConfig,
  type TableState,
} from './types';
