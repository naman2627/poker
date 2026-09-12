import { dealOrder } from './deal';
import { createDeck, shuffle } from './deck';
import { fail } from './errors';
import { isBettingRoundComplete, isBettingStreet, legalActions } from './legal-actions';
import { buildPots } from './pots';
import { resolveShowdown, showdownOrder } from './showdown';
import type { Rng } from './rng';
import { actingSeats, liveSeats, nextIn, nextSeatWhere, occupiedSeats } from './seating';
import type {
  Card,
  Command,
  EngineEvent,
  Phase,
  PlayerActionInput,
  ReduceResult,
  SeatStatus,
  TableConfig,
  TableState,
} from './types';

/**
 * The whole rulebook, as one pure function.
 *
 *   reduce(state, command, rng) -> { state, events }
 *
 * It never mutates `state`, never reads the clock (a command carries `now` when
 * a timestamp is needed) and never reaches for ambient randomness (the shuffle
 * takes every index from `rng`). The same inputs always produce the same result,
 * which is what lets a whole hand be replayed from its command log.
 */
export function reduce(state: TableState, cmd: Command, rng: Rng): ReduceResult {
  const draft = cloneState(state);
  const events: EngineEvent[] = [];

  switch (cmd.type) {
    case 'SIT':
      applySit(draft, cmd.seatIndex, cmd.playerId, cmd.stack, events);
      break;
    case 'LEAVE':
      applyLeave(draft, cmd.seatIndex, events);
      break;
    case 'SET_SITTING_OUT':
      applySetSittingOut(draft, cmd.seatIndex, cmd.sittingOut, events);
      break;
    case 'REBUY':
      applyRebuy(draft, cmd.seatIndex, cmd.amount, events);
      break;
    case 'START_HAND':
      applyStartHand(draft, cmd.handId, rng, events);
      break;
    case 'POST_BLINDS':
      applyPostBlinds(draft, events);
      break;
    case 'DEAL_HOLE':
      applyDealHole(draft, events);
      break;
    case 'PLAYER_ACTION':
      applyPlayerAction(draft, cmd.seatIndex, cmd.action, events);
      break;
    case 'TIMEOUT':
      applyTimeout(draft, cmd.seatIndex, cmd.now, events);
      break;
    case 'ADVANCE_STREET':
      applyAdvanceStreet(draft, events);
      break;
  }

  return { state: draft, events };
}

/** An empty table. Seats are created by SIT. */
export function createTable(config: TableConfig): TableState {
  const { seatCount, smallBlind, bigBlind } = config;
  if (!Number.isInteger(seatCount) || seatCount < 2 || seatCount > 10) {
    fail('INVALID_CONFIG', `seatCount must be an integer in [2, 10], got ${String(seatCount)}`);
  }
  if (!isPositiveInt(smallBlind) || !isPositiveInt(bigBlind)) {
    fail('INVALID_CONFIG', 'blinds must be positive integers');
  }
  if (smallBlind > bigBlind) {
    fail('INVALID_CONFIG', 'the small blind cannot exceed the big blind');
  }

  return {
    handId: null,
    handNumber: 0,
    phase: 'waiting',
    buttonSeat: null,
    sbSeat: null,
    bbSeat: null,
    smallBlind,
    bigBlind,
    deck: [],
    board: [],
    seats: Array.from({ length: seatCount }, () => null),
    currentBet: 0,
    minRaise: bigBlind,
    lastAggressorSeat: null,
    toActSeat: null,
    pots: [],
    dealtInSeats: [],
    pendingLeave: [],
  };
}

/* ------------------------------------------------------------------ *
 * Mutable working copy                                                *
 * ------------------------------------------------------------------ */

interface DraftSeat {
  seatIndex: number;
  playerId: string;
  stack: number;
  status: SeatStatus;
  sittingOut: boolean;
  holeCards: Card[];
  committedThisRound: number;
  committedThisHand: number;
  hasActedThisRound: boolean;
}

interface Draft {
  handId: string | null;
  handNumber: number;
  phase: Phase;
  buttonSeat: number | null;
  sbSeat: number | null;
  bbSeat: number | null;
  smallBlind: number;
  bigBlind: number;
  deck: Card[];
  board: Card[];
  seats: (DraftSeat | null)[];
  currentBet: number;
  minRaise: number;
  lastAggressorSeat: number | null;
  toActSeat: number | null;
  pots: { amount: number; eligibleSeats: number[] }[];
  dealtInSeats: number[];
  pendingLeave: number[];
}

function cloneState(state: TableState): Draft {
  return {
    handId: state.handId,
    handNumber: state.handNumber,
    phase: state.phase,
    buttonSeat: state.buttonSeat,
    sbSeat: state.sbSeat,
    bbSeat: state.bbSeat,
    smallBlind: state.smallBlind,
    bigBlind: state.bigBlind,
    deck: [...state.deck],
    board: [...state.board],
    seats: state.seats.map((seat) =>
      seat === null
        ? null
        : {
            seatIndex: seat.seatIndex,
            playerId: seat.playerId,
            stack: seat.stack,
            status: seat.status,
            sittingOut: seat.sittingOut,
            holeCards: [...seat.holeCards],
            committedThisRound: seat.committedThisRound,
            committedThisHand: seat.committedThisHand,
            hasActedThisRound: seat.hasActedThisRound,
          },
    ),
    currentBet: state.currentBet,
    minRaise: state.minRaise,
    lastAggressorSeat: state.lastAggressorSeat,
    toActSeat: state.toActSeat,
    pots: state.pots.map((pot) => ({ amount: pot.amount, eligibleSeats: [...pot.eligibleSeats] })),
    dealtInSeats: [...state.dealtInSeats],
    pendingLeave: [...state.pendingLeave],
  };
}

/* ------------------------------------------------------------------ *
 * Table membership                                                    *
 * ------------------------------------------------------------------ */

function applySit(
  draft: Draft,
  seatIndex: number,
  playerId: string,
  stack: number,
  events: EngineEvent[],
): void {
  assertSeatInRange(draft, seatIndex);
  if (draft.seats[seatIndex] !== null) {
    fail('SEAT_TAKEN', `seat ${String(seatIndex)} is already occupied`);
  }
  if (!isPositiveInt(stack)) {
    fail('INVALID_AMOUNT', `a buy-in must be a positive integer, got ${String(stack)}`);
  }

  // A new player is seated but not in the hand: START_HAND deals them in.
  draft.seats[seatIndex] = {
    seatIndex,
    playerId,
    stack,
    status: 'sitting_out',
    sittingOut: false,
    holeCards: [],
    committedThisRound: 0,
    committedThisHand: 0,
    hasActedThisRound: false,
  };
  events.push({ type: 'PLAYER_SAT', seatIndex, playerId, stack });
}

/**
 * Standing up.
 *
 * Between hands the seat is simply vacated. Mid-hand it is not: the chips it has
 * already committed belong to the pot, and the pot is derived from the seats, so
 * the seat stays until the hand ends.
 *
 * The hand itself is *not* folded on the spot. A player who walks away with a
 * check available should not be made to fold it, and folding out of turn tells
 * everybody still to act something they have not paid to know. So the seat is
 * marked as leaving and folds when the action reaches it — the moment where
 * folding is a real option and costs it nothing it had not already lost.
 */
function applyLeave(draft: Draft, seatIndex: number, events: EngineEvent[]): void {
  const seat = seatOf(draft, seatIndex);

  if (!isHandInProgress(draft) || seat.status === 'sitting_out') {
    vacate(draft, seatIndex, events);
    return;
  }

  draft.pendingLeave = [...new Set([...draft.pendingLeave, seatIndex])];
  events.push({ type: 'PLAYER_LEAVE_PENDING', seatIndex, playerId: seat.playerId });

  const wasToAct = draft.toActSeat === seatIndex;

  // Two cases fold on the spot. Before the cards are out there is no turn to
  // wait for, and no sense dealing two of them to somebody who has gone. And a
  // player already on the clock *is* at their next turn.
  if (draft.phase === 'hand_start' || wasToAct) foldSeat(seat, events);

  if (wasToAct) {
    continueOrCloseRound(draft, seatIndex, events);
    return;
  }

  // Only while there is still betting to do. Past the river the pots are final
  // and may already have been paid out; rebuilding them from commitments that
  // have not been cleared would put chips back that are no longer there.
  if (isBettingStreet(draft)) {
    refreshPots(draft);
    if (liveSeats(draft).length <= 1) enterPayout(draft, events);
  }
}

/**
 * "Deal me out", and "deal me back in".
 *
 * The flag is sticky, so it survives the hand it was set during and every hand
 * after it. Asked mid-hand it changes nothing about that hand — the player has
 * chips in the pot and a hand to play — it only means START_HAND passes them
 * over next time.
 */
function applySetSittingOut(
  draft: Draft,
  seatIndex: number,
  sittingOut: boolean,
  events: EngineEvent[],
): void {
  const seat = seatOf(draft, seatIndex);
  if (seat.sittingOut === sittingOut) return;

  seat.sittingOut = sittingOut;

  // Between hands there is no hand to stay in, so the status can follow at once
  // and the table shows who is going to be dealt the next one.
  if (!isHandInProgress(draft)) {
    seat.status = sittingOut ? 'sitting_out' : 'active';
  }

  events.push({ type: 'PLAYER_SITTING_OUT_CHANGED', seatIndex, sittingOut });
}

/** Fold a seat that did not choose it: a clock running out, or a player walking off. */
function foldSeat(seat: DraftSeat, events: EngineEvent[]): void {
  if (seat.status !== 'active') return;
  seat.status = 'folded';
  seat.hasActedThisRound = true;
  events.push({
    type: 'PLAYER_ACTED',
    seatIndex: seat.seatIndex,
    action: 'FOLD',
    committedThisRound: seat.committedThisRound,
    allIn: false,
  });
}

function applyRebuy(draft: Draft, seatIndex: number, amount: number, events: EngineEvent[]): void {
  const seat = seatOf(draft, seatIndex);
  if (!isPositiveInt(amount)) {
    fail('INVALID_AMOUNT', `a rebuy must be a positive integer, got ${String(amount)}`);
  }
  if (isHandInProgress(draft) && seat.status !== 'sitting_out') {
    fail('ILLEGAL_ACTION', `seat ${String(seatIndex)} cannot rebuy in the middle of a hand`);
  }

  seat.stack += amount;
  events.push({ type: 'PLAYER_REBOUGHT', seatIndex, amount, stack: seat.stack });
}

function vacate(draft: Draft, seatIndex: number, events: EngineEvent[]): void {
  const seat = seatOf(draft, seatIndex);
  draft.seats[seatIndex] = null;
  draft.pendingLeave = draft.pendingLeave.filter((index) => index !== seatIndex);
  events.push({ type: 'PLAYER_LEFT', seatIndex, playerId: seat.playerId });
}

/* ------------------------------------------------------------------ *
 * Starting a hand                                                     *
 * ------------------------------------------------------------------ */

function applyStartHand(draft: Draft, handId: string, rng: Rng, events: EngineEvent[]): void {
  if (draft.phase !== 'waiting' && draft.phase !== 'hand_end') {
    fail('WRONG_PHASE', `cannot start a hand from phase ${draft.phase}`);
  }

  for (const seatIndex of [...draft.pendingLeave]) vacate(draft, seatIndex, events);

  const dealtIn = occupiedSeats(draft)
    .filter((seat) => seat.stack > 0 && !seat.sittingOut)
    .map((seat) => seat.seatIndex);
  if (dealtIn.length < 2) {
    fail('NOT_ENOUGH_PLAYERS', 'a hand needs at least two seats with chips');
  }

  const buttonSeat = chooseButton(draft, dealtIn);
  const { sbSeat, bbSeat } = assignBlinds(draft.seats.length, buttonSeat, dealtIn);

  for (const seat of draft.seats) {
    if (seat === null) continue;
    seat.status = dealtIn.includes(seat.seatIndex) ? 'active' : 'sitting_out';
    seat.holeCards = [];
    seat.committedThisRound = 0;
    seat.committedThisHand = 0;
    seat.hasActedThisRound = false;
  }

  draft.handId = handId;
  draft.handNumber += 1;
  draft.buttonSeat = buttonSeat;
  draft.sbSeat = sbSeat;
  draft.bbSeat = bbSeat;
  draft.deck = shuffle(createDeck(), rng);
  draft.board = [];
  draft.pots = [];
  draft.currentBet = 0;
  draft.minRaise = draft.bigBlind;
  draft.lastAggressorSeat = null;
  draft.toActSeat = null;
  draft.dealtInSeats = dealtIn;

  setPhase(draft, 'hand_start', events);
  events.push({
    type: 'HAND_STARTED',
    handId,
    handNumber: draft.handNumber,
    buttonSeat,
    sbSeat,
    bbSeat,
    dealtInSeats: dealtIn,
  });
}

/**
 * The button moves to the next seat that was dealt into the previous hand, even
 * if that seat is now empty — a dead button, which is what stops a player from
 * dodging a blind by standing up (CLAUDE.md rule 9).
 */
function chooseButton(draft: Draft, dealtIn: readonly number[]): number {
  const first = dealtIn[0];
  if (first === undefined) fail('NOT_ENOUGH_PLAYERS', 'no seats to deal in');
  if (draft.buttonSeat === null || draft.dealtInSeats.length === 0) return first;
  return nextIn(draft.seats.length, draft.buttonSeat, draft.dealtInSeats) ?? first;
}

/**
 * Heads-up, the button is the small blind and the other seat is the big blind
 * (rule 4). Three-handed and up, the blinds are the next two dealt-in seats
 * clockwise from the button.
 */
function assignBlinds(
  seatCount: number,
  buttonSeat: number,
  dealtIn: readonly number[],
): { sbSeat: number; bbSeat: number } {
  if (dealtIn.length === 2) {
    const [a, b] = dealtIn;
    if (a === undefined || b === undefined) fail('NOT_ENOUGH_PLAYERS', 'heads-up needs two seats');
    if (buttonSeat === a) return { sbSeat: a, bbSeat: b };
    if (buttonSeat === b) return { sbSeat: b, bbSeat: a };
    // Dead button: the seat that would have been on the button is gone, so the
    // next live seat takes the small blind.
    const sbSeat = nextIn(seatCount, buttonSeat, dealtIn);
    if (sbSeat === null) fail('NOT_ENOUGH_PLAYERS', 'no seat for the small blind');
    return { sbSeat, bbSeat: sbSeat === a ? b : a };
  }

  const sbSeat = nextIn(seatCount, buttonSeat, dealtIn);
  if (sbSeat === null) fail('NOT_ENOUGH_PLAYERS', 'no seat for the small blind');
  const bbSeat = nextIn(seatCount, sbSeat, dealtIn);
  if (bbSeat === null) fail('NOT_ENOUGH_PLAYERS', 'no seat for the big blind');
  return { sbSeat, bbSeat };
}

/**
 * Blinds come out of the stack. A short stack posts what it has and is all-in
 * for less than the blind (rule 6); the amount to call is still a full big
 * blind for everyone else.
 */
function applyPostBlinds(draft: Draft, events: EngineEvent[]): void {
  if (draft.phase !== 'hand_start') {
    fail('WRONG_PHASE', `blinds are posted in hand_start, not ${draft.phase}`);
  }
  if (occupiedSeats(draft).some((seat) => seat.committedThisHand > 0)) {
    fail('WRONG_PHASE', 'blinds have already been posted for this hand');
  }
  const { sbSeat, bbSeat } = draft;
  if (sbSeat === null || bbSeat === null) fail('WRONG_PHASE', 'no blinds assigned');

  postBlind(draft, sbSeat, draft.smallBlind, 'small', events);
  postBlind(draft, bbSeat, draft.bigBlind, 'big', events);

  draft.currentBet = draft.bigBlind;
  draft.minRaise = draft.bigBlind;
  draft.lastAggressorSeat = bbSeat;
  refreshPots(draft);
}

function postBlind(
  draft: Draft,
  seatIndex: number,
  blind: number,
  which: 'small' | 'big',
  events: EngineEvent[],
): void {
  const seat = seatOf(draft, seatIndex);
  const amount = Math.min(blind, seat.stack);
  commitTo(seat, seat.committedThisRound + amount);
  // Posting is not acting: the big blind still has an option (rule 1).
  seat.hasActedThisRound = false;
  events.push({
    type: 'BLIND_POSTED',
    seatIndex,
    blind: which,
    amount,
    allIn: seat.status === 'allin',
  });
}

/**
 * Two cards each, one at a time, starting to the left of the button — the order
 * a dealer uses, and the order a seeded deck must reproduce.
 */
function applyDealHole(draft: Draft, events: EngineEvent[]): void {
  if (draft.phase !== 'hand_start') {
    fail('WRONG_PHASE', `hole cards are dealt in hand_start, not ${draft.phase}`);
  }
  if (draft.buttonSeat === null || draft.bbSeat === null) fail('WRONG_PHASE', 'no button assigned');
  if (occupiedSeats(draft).every((seat) => seat.committedThisHand === 0)) {
    fail('WRONG_PHASE', 'blinds must be posted before the deal');
  }
  if (occupiedSeats(draft).some((seat) => seat.holeCards.length > 0)) {
    fail('WRONG_PHASE', 'hole cards have already been dealt for this hand');
  }

  // Anyone who walked away between the blinds and the deal is already folded,
  // and folded seats are not dealt cards.
  const stillIn = draft.dealtInSeats.filter((seatIndex) => {
    const seat = draft.seats[seatIndex];
    return seat !== undefined && seat !== null && seat.status !== 'folded';
  });
  // The same function the fairness endpoint replays a deal with, so a verified
  // hand is verified against the order the cards actually went out in.
  const order = dealOrder(draft.seats.length, draft.buttonSeat, stillIn);
  for (let pass = 0; pass < 2; pass += 1) {
    for (const seatIndex of order) {
      const [card] = takeCards(draft, 1);
      if (card === undefined) fail('DECK_EXHAUSTED', 'the deck ran out during the deal');
      seatOf(draft, seatIndex).holeCards.push(card);
    }
  }

  events.push({ type: 'HOLE_CARDS_DEALT', seats: order, cardsPerSeat: 2 });
  setPhase(draft, 'preflop', events);

  // Preflop action opens to the left of the big blind (rule 5). Heads-up that is
  // the button, which is why the button acts first before the flop (rule 4).
  continueOrCloseRound(draft, draft.bbSeat, events);
}

/* ------------------------------------------------------------------ *
 * Betting                                                             *
 * ------------------------------------------------------------------ */

function applyTimeout(draft: Draft, seatIndex: number, now: number, events: EngineEvent[]): void {
  if (!isBettingStreet(draft)) {
    fail('WRONG_PHASE', `nobody is on the clock in phase ${draft.phase}`);
  }
  if (draft.toActSeat !== seatIndex) {
    fail('NOT_YOUR_TURN', `seat ${String(seatIndex)} is not on the clock`);
  }

  // A free card is never thrown away: a seat that can check, checks down.
  const appliedAction = legalActions(draft, seatIndex).canCheck ? 'CHECK' : 'FOLD';
  events.push({ type: 'ACTION_TIMED_OUT', seatIndex, now, appliedAction });
  applyPlayerAction(draft, seatIndex, { type: appliedAction }, events);
}

function applyPlayerAction(
  draft: Draft,
  seatIndex: number,
  action: PlayerActionInput,
  events: EngineEvent[],
): void {
  if (!isBettingStreet(draft)) {
    fail('WRONG_PHASE', `no betting is open in phase ${draft.phase}`);
  }
  if (draft.toActSeat !== seatIndex) {
    fail('NOT_YOUR_TURN', `it is seat ${String(draft.toActSeat)}'s turn, not ${String(seatIndex)}`);
  }

  const seat = seatOf(draft, seatIndex);
  const legal = legalActions(draft, seatIndex);

  switch (action.type) {
    case 'FOLD': {
      if (!legal.canFold) fail('ILLEGAL_ACTION', `seat ${String(seatIndex)} cannot fold`);
      seat.status = 'folded';
      seat.hasActedThisRound = true;
      break;
    }
    case 'CHECK': {
      if (!legal.canCheck) {
        fail('ILLEGAL_ACTION', `seat ${String(seatIndex)} cannot check facing a bet`);
      }
      seat.hasActedThisRound = true;
      break;
    }
    case 'CALL': {
      if (!legal.canCall) fail('ILLEGAL_ACTION', `seat ${String(seatIndex)} has nothing to call`);
      commitTo(seat, seat.committedThisRound + legal.callAmount);
      seat.hasActedThisRound = true;
      break;
    }
    case 'BET': {
      if (!legal.canBet) {
        fail('ILLEGAL_ACTION', `seat ${String(seatIndex)} cannot bet facing a bet; raise instead`);
      }
      assertAmountInRange(action.amount, legal.minRaiseTo, legal.maxRaiseTo);
      applyAggression(draft, seat, action.amount);
      break;
    }
    case 'RAISE': {
      if (!legal.canRaise) {
        fail('ILLEGAL_ACTION', `seat ${String(seatIndex)} cannot raise here`);
      }
      assertAmountInRange(action.amount, legal.minRaiseTo, legal.maxRaiseTo);
      applyAggression(draft, seat, action.amount);
      break;
    }
    case 'ALL_IN': {
      const target = seat.committedThisRound + seat.stack;
      if (target > draft.currentBet) {
        // Shoving is still a raise, so it is closed off to a seat an under-sized
        // all-in has already passed (rule 3).
        if (!legal.canBet && !legal.canRaise) {
          fail('ILLEGAL_ACTION', `seat ${String(seatIndex)} may only call or fold here`);
        }
        applyAggression(draft, seat, target);
      } else {
        // Short of the current bet: an all-in call, which raises nothing.
        commitTo(seat, target);
        seat.hasActedThisRound = true;
      }
      break;
    }
  }

  events.push({
    type: 'PLAYER_ACTED',
    seatIndex,
    action: action.type,
    committedThisRound: seat.committedThisRound,
    allIn: seat.status === 'allin',
  });

  continueOrCloseRound(draft, seatIndex, events);
}

/**
 * A bet or raise to `target`.
 *
 * The raise counts as full only if it lifts the bet by at least the last full
 * raise (rule 2); a full raise also sets the new `minRaise` and clears
 * `hasActedThisRound` for everyone else, reopening the action to them (rule 1).
 * A short all-in raises `currentBet` — everyone still owes the extra — but
 * leaves both alone, so a seat that already matched may only call or fold, while
 * a seat that has not acted yet keeps the full range (rule 3).
 */
function applyAggression(draft: Draft, seat: DraftSeat, target: number): void {
  const previousBet = draft.currentBet;
  commitTo(seat, target);

  const raiseSize = target - previousBet;
  if (raiseSize >= draft.minRaise) {
    draft.minRaise = raiseSize;
    for (const other of draft.seats) {
      if (other !== null && other.seatIndex !== seat.seatIndex && other.status === 'active') {
        other.hasActedThisRound = false;
      }
    }
  }

  draft.currentBet = target;
  draft.lastAggressorSeat = seat.seatIndex;
  seat.hasActedThisRound = true;
}

/** Move `seat`'s committed total for this round up to `target`. */
function commitTo(seat: DraftSeat, target: number): void {
  const delta = target - seat.committedThisRound;
  if (delta < 0) fail('INVALID_AMOUNT', 'a seat cannot take chips back out of the pot');
  if (delta > seat.stack) {
    fail('INVALID_AMOUNT', `seat ${String(seat.seatIndex)} does not have ${String(delta)} chips`);
  }

  seat.stack -= delta;
  seat.committedThisRound += delta;
  seat.committedThisHand += delta;
  if (seat.stack === 0) seat.status = 'allin';
}

/**
 * Hand the action to the next seat that owes one, or close the round.
 *
 * A seat owes an action if it has not acted since the last full raise, or if it
 * has not matched the current bet — which is how a short all-in still makes
 * everyone respond without letting them re-raise.
 */
function continueOrCloseRound(draft: Draft, from: number, events: EngineEvent[]): void {
  refreshPots(draft);

  // Everyone but one has folded: no more cards, straight to the payout (rule 7).
  if (liveSeats(draft).length <= 1) {
    enterPayout(draft, events);
    return;
  }

  if (isBettingRoundComplete(draft)) {
    draft.toActSeat = null;
    events.push({ type: 'BETTING_ROUND_ENDED', phase: draft.phase });
    return;
  }

  const next = nextSeatWhere(
    draft,
    from,
    (seat) =>
      seat.status === 'active' &&
      (!seat.hasActedThisRound || seat.committedThisRound !== draft.currentBet),
  );

  if (next === null) {
    draft.toActSeat = null;
    events.push({ type: 'BETTING_ROUND_ENDED', phase: draft.phase });
    return;
  }

  // A seat whose player has stood up does not get a turn: this is where its fold
  // lands. Each one removes a live seat, so the recursion always ends.
  const leaver = draft.seats[next] ?? null;
  if (leaver !== null && draft.pendingLeave.includes(next)) {
    foldSeat(leaver, events);
    continueOrCloseRound(draft, next, events);
    return;
  }

  draft.toActSeat = next;
  events.push({ type: 'ACTION_ON', seatIndex: next });
}

/* ------------------------------------------------------------------ *
 * Streets                                                             *
 * ------------------------------------------------------------------ */

function applyAdvanceStreet(draft: Draft, events: EngineEvent[]): void {
  switch (draft.phase) {
    case 'preflop':
    case 'flop':
    case 'turn':
    case 'river': {
      if (draft.toActSeat !== null || !isBettingRoundComplete(draft)) {
        fail('ROUND_IN_PROGRESS', `seat ${String(draft.toActSeat)} still has to act`);
      }
      startNextStreet(draft, events);
      return;
    }
    case 'showdown':
      enterPayout(draft, events);
      return;
    case 'payout':
      endHand(draft, events);
      return;
    default:
      fail('WRONG_PHASE', `there is no street to advance from ${draft.phase}`);
  }
}

function startNextStreet(draft: Draft, events: EngineEvent[]): void {
  if (liveSeats(draft).length <= 1) {
    enterPayout(draft, events);
    return;
  }

  // Two or more left but at most one of them can still act: there is nothing to
  // bet, so the board runs out in one go and the hand goes to showdown (rule 8).
  if (actingSeats(draft).length <= 1) {
    runOutBoard(draft, events);
    return;
  }

  if (draft.phase === 'river') {
    enterShowdown(draft, events);
    return;
  }

  dealNextStreet(draft, events);
  openBettingRound(draft, events);
}

function runOutBoard(draft: Draft, events: EngineEvent[]): void {
  while (draft.board.length < 5) dealNextStreet(draft, events);
  enterShowdown(draft, events);
}

function dealNextStreet(draft: Draft, events: EngineEvent[]): void {
  const count = draft.board.length === 0 ? 3 : 1;
  const phase: 'flop' | 'turn' | 'river' =
    draft.board.length === 0 ? 'flop' : draft.board.length === 3 ? 'turn' : 'river';

  const cards = takeCards(draft, count);
  draft.board.push(...cards);
  setPhase(draft, phase, events);
  events.push({ type: 'BOARD_DEALT', phase, cards });
}

/** Fresh round: nothing committed, no bet, action opens left of the button. */
function openBettingRound(draft: Draft, events: EngineEvent[]): void {
  for (const seat of draft.seats) {
    if (seat === null) continue;
    seat.committedThisRound = 0;
    seat.hasActedThisRound = false;
  }
  draft.currentBet = 0;
  draft.minRaise = draft.bigBlind;
  draft.lastAggressorSeat = null;

  const buttonSeat = draft.buttonSeat;
  if (buttonSeat === null) fail('WRONG_PHASE', 'no button assigned');
  continueOrCloseRound(draft, buttonSeat, events);
}

/**
 * Cards down.
 *
 * The hands are turned over *here*, one phase before the chips move, because
 * that is the order a table does it in: everybody sees what won before the pot
 * is pushed. Who shows and who mucks is `resolveShowdown`'s decision, and a hand
 * it does not name is never revealed by anything downstream.
 *
 * `SHOWDOWN_REACHED` carries the seats in showdown order, not seat order.
 */
function enterShowdown(draft: Draft, events: EngineEvent[]): void {
  draft.toActSeat = null;
  refreshPots(draft);
  setPhase(draft, 'showdown', events);
  events.push({ type: 'SHOWDOWN_REACHED', seats: showdownOrder(draft) });

  const { revealed, mucked } = resolveShowdown(draft);

  // Emitted in showdown order, shows and mucks interleaved, so a client can
  // simply play the stream and watch the table turn over one seat at a time.
  const shown: EngineEvent[] = [
    ...revealed.map((reveal): EngineEvent => ({
      type: 'HAND_REVEALED',
      seatIndex: reveal.seatIndex,
      cards: reveal.cards,
      handName: reveal.handName,
      category: reveal.category,
      order: reveal.order,
    })),
    ...mucked.map((muck): EngineEvent => ({
      type: 'HAND_MUCKED',
      seatIndex: muck.seatIndex,
      order: muck.order,
    })),
  ].sort((a, b) => orderOf(a) - orderOf(b));

  events.push(...shown);
}

function orderOf(event: EngineEvent): number {
  return 'order' in event ? event.order : 0;
}

/**
 * Pots are final here. Any pot with a single eligible seat is paid out right
 * away — an uncontested hand, or the uncalled top of an over-bet coming back to
 * the seat that put it in. Contested pots need hands compared, which is the next
 * phase of work, so they are left standing.
 */
function enterPayout(draft: Draft, events: EngineEvent[]): void {
  draft.toActSeat = null;
  refreshPots(draft);
  setPhase(draft, 'payout', events);

  // The reveals went out when the phase turned to `showdown`; this is only the
  // chips. A payout reached without a showdown — everybody folded — had nothing
  // to reveal in the first place.
  const { awards } = resolveShowdown(draft);

  for (const award of awards) {
    seatOf(draft, award.seatIndex).stack += award.amount;
    events.push({
      type: 'POT_AWARDED',
      seatIndex: award.seatIndex,
      amount: award.amount,
      potIndex: award.potIndex,
    });
  }

  // Only a pot nobody is eligible for can survive the payout, and that takes a
  // hand every last contributor walked out of.
  draft.pots = draft.pots.filter((pot) => pot.eligibleSeats.length === 0);
}

function endHand(draft: Draft, events: EngineEvent[]): void {
  setPhase(draft, 'hand_end', events);
  draft.toActSeat = null;
  for (const seatIndex of [...draft.pendingLeave]) vacate(draft, seatIndex, events);
  events.push({ type: 'HAND_ENDED', handNumber: draft.handNumber });
}

/* ------------------------------------------------------------------ *
 * Small helpers                                                       *
 * ------------------------------------------------------------------ */

function setPhase(draft: Draft, to: Phase, events: EngineEvent[]): void {
  if (draft.phase === to) return;
  events.push({ type: 'PHASE_CHANGED', from: draft.phase, to });
  draft.phase = to;
}

function refreshPots(draft: Draft): void {
  draft.pots = buildPots(draft.seats).map((pot) => ({
    amount: pot.amount,
    eligibleSeats: [...pot.eligibleSeats],
  }));
}

function takeCards(draft: Draft, count: number): Card[] {
  if (draft.deck.length < count) {
    fail(
      'DECK_EXHAUSTED',
      `the deck has ${String(draft.deck.length)} cards, needed ${String(count)}`,
    );
  }
  const cards = draft.deck.slice(0, count);
  draft.deck = draft.deck.slice(count);
  return cards;
}

function seatOf(draft: Draft, seatIndex: number): DraftSeat {
  assertSeatInRange(draft, seatIndex);
  const seat = draft.seats[seatIndex];
  if (!seat) fail('SEAT_NOT_FOUND', `seat ${String(seatIndex)} is empty`);
  return seat;
}

function assertSeatInRange(draft: Draft, seatIndex: number): void {
  if (!Number.isInteger(seatIndex) || seatIndex < 0 || seatIndex >= draft.seats.length) {
    fail('SEAT_OUT_OF_RANGE', `seat ${String(seatIndex)} is not a seat at this table`);
  }
}

function assertAmountInRange(amount: number, min: number, max: number): void {
  if (!Number.isInteger(amount)) {
    fail('INVALID_AMOUNT', `chips are whole, got ${String(amount)}`);
  }
  if (amount < min || amount > max) {
    fail(
      'INVALID_AMOUNT',
      `${String(amount)} is outside the legal range [${String(min)}, ${String(max)}]`,
    );
  }
}

function isHandInProgress(draft: Draft): boolean {
  return draft.phase !== 'waiting' && draft.phase !== 'hand_end';
}

function isPositiveInt(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}
