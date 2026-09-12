/**
 * Test scaffolding. Nothing here knows a poker rule — it only saves every test
 * from spelling out the same SIT / START_HAND / POST_BLINDS / DEAL_HOLE prelude.
 */
import {
  buildPots,
  createTable,
  reduce,
  seededRng,
  totalPot,
  type Card,
  type Command,
  type EngineEvent,
  type PlayerActionInput,
  type Rank,
  type Rng,
  type Seat,
  type SeatStatus,
  type TableState,
} from '../src/index';

export interface Options {
  readonly seatCount?: number;
  readonly smallBlind?: number;
  readonly bigBlind?: number;
  /** Seats to fill, by index. Defaults to 0..stacks.length - 1. */
  readonly seats?: readonly number[];
}

/** An empty table with `stacks.length` players seated and no hand dealt. */
export function tableWith(stacks: readonly number[], options: Options = {}): TableState {
  const seatCount = options.seatCount ?? stacks.length;
  const seats = options.seats ?? stacks.map((_, index) => index);

  let state = createTable({
    seatCount,
    smallBlind: options.smallBlind ?? 5,
    bigBlind: options.bigBlind ?? 10,
  });

  stacks.forEach((stack, position) => {
    const seatIndex = seats[position];
    if (seatIndex === undefined) throw new Error(`no seat for stack ${String(position)}`);
    state = run(state, [{ type: 'SIT', seatIndex, playerId: `p${String(seatIndex)}`, stack }]);
  });

  return state;
}

/** Feed commands through the reducer, discarding the events. */
export function run(
  state: TableState,
  commands: readonly Command[],
  rng: Rng = seededRng('test'),
): TableState {
  return runWithEvents(state, commands, rng).state;
}

/** Feed commands through the reducer, keeping every event in order. */
export function runWithEvents(
  state: TableState,
  commands: readonly Command[],
  rng: Rng = seededRng('test'),
): { state: TableState; events: EngineEvent[] } {
  let next = state;
  const events: EngineEvent[] = [];
  for (const command of commands) {
    const result = reduce(next, command, rng);
    next = result.state;
    events.push(...result.events);
  }
  return { state: next, events };
}

/** SIT-ed table -> hole cards dealt, preflop, first player on the clock. */
export function dealHand(
  state: TableState,
  handId = 'hand-1',
  rng: Rng = seededRng('test'),
): TableState {
  return run(
    state,
    [{ type: 'START_HAND', handId }, { type: 'POST_BLINDS' }, { type: 'DEAL_HOLE' }],
    rng,
  );
}

/** Shorthand for a table of `stacks` with a hand already dealt. */
export function preflop(stacks: readonly number[], options: Options = {}): TableState {
  return dealHand(tableWith(stacks, options));
}

export function seatAt(state: TableState, seatIndex: number): Seat {
  const seat = state.seats[seatIndex];
  if (!seat) throw new Error(`seat ${String(seatIndex)} is empty`);
  return seat;
}

export function stacks(state: TableState): (number | null)[] {
  return state.seats.map((seat) => (seat ? seat.stack : null));
}

export function statuses(state: TableState): (string | null)[] {
  return state.seats.map((seat) => (seat ? seat.status : null));
}

/** Total chips in play: every stack plus everything still sitting in the pots. */
export function chipsInPlay(state: TableState): number {
  const inStacks = state.seats.reduce((total, seat) => (seat ? total + seat.stack : total), 0);
  return inStacks + totalPot(state.pots);
}

export const act = {
  fold: (seatIndex: number): Command => player(seatIndex, { type: 'FOLD' }),
  check: (seatIndex: number): Command => player(seatIndex, { type: 'CHECK' }),
  call: (seatIndex: number): Command => player(seatIndex, { type: 'CALL' }),
  bet: (seatIndex: number, amount: number): Command => player(seatIndex, { type: 'BET', amount }),
  raise: (seatIndex: number, amount: number): Command =>
    player(seatIndex, { type: 'RAISE', amount }),
  allIn: (seatIndex: number): Command => player(seatIndex, { type: 'ALL_IN' }),
};

export const advance: Command = { type: 'ADVANCE_STREET' };

export function timeout(seatIndex: number, now = 1_700_000_000_000): Command {
  return { type: 'TIMEOUT', seatIndex, now };
}

function player(seatIndex: number, action: PlayerActionInput): Command {
  return { type: 'PLAYER_ACTION', seatIndex, action };
}

/* ------------------------------------------------------------------ *
 * Cards                                                               *
 * ------------------------------------------------------------------ */

const RANK_CHARS: Readonly<Record<string, Rank>> = {
  '2': 2,
  '3': 3,
  '4': 4,
  '5': 5,
  '6': 6,
  '7': 7,
  '8': 8,
  '9': 9,
  T: 10,
  J: 11,
  Q: 12,
  K: 13,
  A: 14,
};

/** `card('Ah')` — rank character then suit, ten is `T`. */
export function card(text: string): Card {
  const rank = RANK_CHARS[text[0]?.toUpperCase() ?? ''];
  const suit = text[1]?.toLowerCase();
  if (rank === undefined || (suit !== 's' && suit !== 'h' && suit !== 'd' && suit !== 'c')) {
    throw new Error(`cannot read the card "${text}"`);
  }
  return { rank, suit };
}

/** `cards('Ah Kd 7c')` */
export function cards(text: string): Card[] {
  return text.split(/\s+/).filter(Boolean).map(card);
}

/* ------------------------------------------------------------------ *
 * Showdown fixtures                                                   *
 * ------------------------------------------------------------------ */

export interface ShowdownSeatSpec {
  readonly seatIndex: number;
  /** Two cards, e.g. `'Ah Kd'`. Omit for a seat that never saw a card. */
  readonly hole?: string;
  readonly committed: number;
  /** Defaults to `allin`, which is what puts a seat in a side-pot layer. */
  readonly status?: SeatStatus;
  readonly stack?: number;
}

export interface ShowdownSpec {
  readonly board: string;
  readonly seats: readonly ShowdownSeatSpec[];
  readonly buttonSeat?: number;
  readonly seatCount?: number;
}

/**
 * A table parked at a showdown with exactly the cards and commitments a test
 * wants. Pots are built from the commitments, the same way the reducer does it.
 */
export function showdownTable(spec: ShowdownSpec): TableState {
  const seatCount = spec.seatCount ?? Math.max(...spec.seats.map((seat) => seat.seatIndex)) + 1;

  const seats: (Seat | null)[] = Array.from({ length: seatCount }, () => null);
  for (const seat of spec.seats) {
    seats[seat.seatIndex] = {
      seatIndex: seat.seatIndex,
      playerId: `p${String(seat.seatIndex)}`,
      stack: seat.stack ?? 0,
      status: seat.status ?? 'allin',
      sittingOut: false,
      holeCards: seat.hole === undefined ? [] : cards(seat.hole),
      committedThisRound: 0,
      committedThisHand: seat.committed,
      hasActedThisRound: true,
    };
  }

  return {
    ...createTable({ seatCount, smallBlind: 5, bigBlind: 10 }),
    handId: 'showdown',
    handNumber: 1,
    phase: 'showdown',
    buttonSeat: spec.buttonSeat ?? 0,
    board: cards(spec.board),
    seats,
    pots: buildPots(seats),
  };
}
