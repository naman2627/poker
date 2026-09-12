/**
 * Five thousand hands played out at random against a seeded rng.
 *
 * The hands mean nothing on their own — the point is what must hold after every
 * one of them: chips are conserved to the last one, and no stack ever goes below
 * zero. Anything the rules get wrong about side pots, short all-ins or split
 * pots eventually shows up as a chip that appeared out of nowhere or vanished.
 */
import { describe, expect, it } from 'vitest';
import {
  legalActions,
  reduce,
  seededRng,
  totalPot,
  type Command,
  type PlayerActionInput,
  type Rng,
  type TableState,
} from '../src/index';
import { tableWith } from './helpers';

const HANDS = 5_000;
const SEAT_COUNT = 6;
const STARTING_STACK = 500;

describe('5,000 random hands', () => {
  it('never creates, destroys or overdraws a chip', () => {
    const rng = seededRng('property-hands');

    let table = freshTable();
    let chips = chipsOn(table);
    let handsPlayed = 0;
    let showdowns = 0;
    let sidePots = 0;

    while (handsPlayed < HANDS) {
      if (fundedSeats(table) < 2) {
        // The table played itself down to one stack; rack up a fresh one.
        table = freshTable();
        chips = chipsOn(table);
        continue;
      }

      const hand = playHand(table, `hand-${String(handsPlayed)}`, rng);
      table = hand.state;
      handsPlayed += 1;

      if (table.board.length === 5) showdowns += 1;
      if (hand.maxPotLayers > 1) sidePots += 1;

      expect(chipsOn(table)).toBe(chips);
      for (const seat of table.seats) {
        if (seat === null) continue;
        expect(seat.stack).toBeGreaterThanOrEqual(0);
        expect(Number.isSafeInteger(seat.stack)).toBe(true);
      }
      // Nothing is left sitting in a pot once a hand is settled.
      expect(totalPot(table.pots)).toBe(0);
    }

    expect(handsPlayed).toBe(HANDS);
    // A run this long that never reached a showdown, or never built a side pot,
    // would not be exercising the part of the code this test is here to guard.
    expect(showdowns).toBeGreaterThan(HANDS / 100);
    expect(sidePots).toBeGreaterThan(0);
  });
});

function freshTable(): TableState {
  return tableWith(Array<number>(SEAT_COUNT).fill(STARTING_STACK));
}

function chipsOn(state: TableState): number {
  const inStacks = state.seats.reduce((sum, seat) => (seat ? sum + seat.stack : sum), 0);
  return inStacks + totalPot(state.pots);
}

function fundedSeats(state: TableState): number {
  return state.seats.filter((seat) => seat !== null && seat.stack > 0).length;
}

/** Deal a hand, act at random until it is over, and settle it. */
function playHand(
  start: TableState,
  handId: string,
  rng: Rng,
): { state: TableState; maxPotLayers: number } {
  let state = send(start, { type: 'START_HAND', handId }, rng);
  state = send(state, { type: 'POST_BLINDS' }, rng);
  state = send(state, { type: 'DEAL_HOLE' }, rng);
  let maxPotLayers = 0;

  // A hand cannot need more turns than this: every action either ends a seat's
  // involvement or puts chips in, and the streets run out.
  for (let step = 0; step < 500 && state.phase !== 'hand_end'; step += 1) {
    maxPotLayers = Math.max(maxPotLayers, state.pots.length);
    state = send(
      state,
      state.toActSeat === null
        ? { type: 'ADVANCE_STREET' }
        : randomAction(state, state.toActSeat, rng),
      rng,
    );
  }

  expect(state.phase).toBe('hand_end');
  return { state, maxPotLayers };
}

function send(state: TableState, command: Command, rng: Rng): TableState {
  return reduce(state, command, rng).state;
}

/** Pick uniformly from what this seat is actually allowed to do. */
function randomAction(state: TableState, seatIndex: number, rng: Rng): Command {
  const seat = state.seats[seatIndex];
  if (!seat) throw new Error(`seat ${String(seatIndex)} is empty but on the clock`);

  const legal = legalActions(state, seatIndex);
  const actions: PlayerActionInput[] = [];

  if (legal.canFold) actions.push({ type: 'FOLD' });
  if (legal.canCheck) actions.push({ type: 'CHECK' });
  if (legal.canCall) actions.push({ type: 'CALL' });
  if (legal.canBet || legal.canRaise) {
    const spread = legal.maxRaiseTo - legal.minRaiseTo;
    const amount = legal.minRaiseTo + rng.int(spread + 1);
    actions.push({ type: legal.canBet ? 'BET' : 'RAISE', amount });
  }
  // Shoving is a raise, so it is only on offer when raising is (or when the
  // whole stack does not even cover the call).
  if (legal.canBet || legal.canRaise || seat.committedThisRound + seat.stack <= state.currentBet) {
    actions.push({ type: 'ALL_IN' });
  }

  const action = actions[rng.int(actions.length)];
  if (!action) throw new Error(`seat ${String(seatIndex)} had nothing legal to do`);
  return { type: 'PLAYER_ACTION', seatIndex, action };
}
