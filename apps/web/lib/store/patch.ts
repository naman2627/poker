import type { Card, Phase, PublicSeat, PublicTableState, TableEvent } from '@poker/shared';

/**
 * Applying a `state:patch`.
 *
 * The client holds no poker rules (CLAUDE.md §2) and invents no game truth. What
 * it does here is *transcription*: each engine event states a fact, and this
 * file writes that fact into the state the last `state:sync` handed over.
 *
 * The line is worth being precise about, because it is easy to cross:
 *
 *   allowed — writing a number the event carries (`PLAYER_ACTED` says a seat's
 *             total for this street is now 150, so the seat's total is 150), and
 *             the bookkeeping that number *is* (those chips came out of a stack,
 *             so the stack went down by exactly that much)
 *
 *   not allowed — working out whether a raise was legal, who is next to act when
 *             no event said so, what a hand is worth, or how a pot splits.
 *             Nothing here computes any of that; the server says it, or it is
 *             not shown.
 *
 * When an event arrives that this file cannot transcribe faithfully, it says so
 * by returning `resyncNeeded`, and the client asks for a whole state rather than
 * drawing a guess.
 */
export interface PatchResult {
  readonly state: PublicTableState;
  /** Chips this hand already paid back out to a winner. See `potTotal`. */
  readonly awarded: number;
  /** Set when a patch could not be applied and the truth must be re-fetched. */
  readonly resyncNeeded: boolean;
  /** Set when the patch crossed a street, so the pot breakdown is now stale. */
  readonly phaseChanged: boolean;
}

interface Draft {
  state: PublicTableState;
  seats: (PublicSeat | null)[];
  awarded: number;
  resyncNeeded: boolean;
  phaseChanged: boolean;
}

export function applyPatch(
  state: PublicTableState,
  awarded: number,
  events: readonly TableEvent[],
): PatchResult {
  const draft: Draft = {
    state: { ...state },
    seats: [...state.seats],
    awarded,
    resyncNeeded: false,
    phaseChanged: false,
  };

  for (const event of events) applyEvent(draft, event);

  return {
    state: { ...draft.state, seats: draft.seats, leaderboard: restack(draft) },
    awarded: draft.awarded,
    resyncNeeded: draft.resyncNeeded,
    phaseChanged: draft.phaseChanged,
  };
}

/**
 * The live board's stacks, brought up to date with the seats.
 *
 * This is transcription in exactly the sense the note at the top of this file
 * allows: a seat's stack is a number the server stated, and the board's copy of
 * it is the same number. `net`, `handsWon` and `biggestPot` are *not* touched —
 * they are facts about a sitting that only the server knows, and they stay
 * exactly as they last arrived.
 *
 * The server sends a whole board on every patch, and `table-store.ts` prefers
 * it whenever there is one. This is the fallback for the one case where there
 * is no server to send it: the recorded hand the interface is reviewed against.
 * Without it that panel would freeze at the stacks the recording opened with.
 */
function restack(draft: Draft): PublicTableState['leaderboard'] {
  if (draft.state.leaderboard.length === 0) return draft.state.leaderboard;

  return [...draft.state.leaderboard]
    .map((row) => {
      const seat = draft.seats[row.seatIndex];
      return seat === null || seat === undefined || seat.stack === row.stack
        ? row
        : { ...row, stack: seat.stack };
    })
    .sort((a, b) => (b.stack === a.stack ? a.seatIndex - b.seatIndex : b.stack - a.stack));
}

/**
 * What is in the middle.
 *
 * The pot is, by definition, everything the seats have committed to this hand
 * and not yet been paid back — so adding up numbers the server has already
 * stated per seat gives the total without the client doing any pot maths of its
 * own. The *breakdown* into main and side pots is a different question, and one
 * only the server answers: that is `state.pots`, refreshed by a resync at every
 * street (see `lib/store/table-store.ts`).
 */
export function potTotal(state: PublicTableState | null, awarded: number): number {
  if (state === null) return 0;
  const committed = state.seats.reduce((sum, seat) => sum + (seat?.committedThisHand ?? 0), 0);
  return Math.max(0, committed - awarded);
}

/** Chips sitting in front of the seats, not yet swept into the middle. */
export function chipsOnFelt(state: PublicTableState | null): number {
  if (state === null) return 0;
  return state.seats.reduce((sum, seat) => sum + (seat?.committedThisRound ?? 0), 0);
}

function applyEvent(draft: Draft, event: TableEvent): void {
  switch (event.type) {
    case 'HAND_STARTED':
      return handStarted(draft, event);

    case 'BLIND_POSTED':
      commit(draft, asNumber(event.seatIndex), asNumber(event.amount) ?? 0, {
        allIn: event.allIn === true,
        acted: false,
      });
      return;

    case 'HOLE_CARDS_DEALT':
      return holeCardsDealt(draft, event);

    case 'PLAYER_ACTED':
      return playerActed(draft, event);

    case 'ACTION_TIMED_OUT':
      return actionTimedOut(draft, event);

    case 'ACTION_ON':
      draft.state = { ...draft.state, toActSeat: asNumber(event.seatIndex) };
      return;

    case 'BETTING_ROUND_ENDED':
      sweep(draft);
      return;

    case 'BOARD_DEALT':
      return boardDealt(draft, event);

    case 'PHASE_CHANGED':
      return phaseChanged(draft, event);

    case 'SHOWDOWN_REACHED':
      sweep(draft);
      draft.state = { ...draft.state, toActSeat: null };
      return;

    case 'HAND_REVEALED':
      return handRevealed(draft, event);

    case 'HAND_MUCKED':
      return handMucked(draft, event);

    case 'PLAYER_SITTING_OUT_CHANGED':
      return sittingOutChanged(draft, event);

    case 'POT_AWARDED':
      return potAwarded(draft, event);

    case 'HAND_ENDED':
      draft.state = { ...draft.state, toActSeat: null, actionDeadlineTs: null };
      return;

    case 'PLAYER_SAT':
    case 'PLAYER_LEFT':
    case 'PLAYER_LEAVE_PENDING':
    case 'PLAYER_REBOUGHT':
      // Seating changes arrive with a whole state alongside them, so there is
      // nothing to piece together here — the sync that follows is the truth.
      return;

    default:
      // An event this client has never heard of is not a reason to draw
      // something wrong. Ask for the whole state and render that instead.
      draft.resyncNeeded = true;
      return;
  }
}

function handStarted(draft: Draft, event: TableEvent): void {
  const dealtIn = asNumberArray(event.dealtInSeats);

  draft.state = {
    ...draft.state,
    handId: asString(event.handId) ?? draft.state.handId,
    handNumber: asNumber(event.handNumber) ?? draft.state.handNumber,
    buttonSeat: asNumber(event.buttonSeat),
    sbSeat: asNumber(event.sbSeat),
    bbSeat: asNumber(event.bbSeat),
    board: [],
    pots: [],
    currentBet: 0,
    lastAggressorSeat: null,
    muckedSeats: [],
  };
  draft.awarded = 0;
  draft.seats = draft.seats.map((seat) =>
    seat === null
      ? null
      : {
          ...seat,
          status: dealtIn.includes(seat.seatIndex) ? 'active' : seat.status,
          committedThisRound: 0,
          committedThisHand: 0,
          hasActedThisRound: false,
          cardCount: 0,
          holeCards: null,
        },
  );
}

function holeCardsDealt(draft: Draft, event: TableEvent): void {
  const seats = asNumberArray(event.seats);
  const perSeat = asNumber(event.cardsPerSeat) ?? 2;

  draft.seats = draft.seats.map((seat) =>
    seat !== null && seats.includes(seat.seatIndex) ? { ...seat, cardCount: perSeat } : seat,
  );
}

function playerActed(draft: Draft, event: TableEvent): void {
  const action = asString(event.action) ?? '';
  const seatIndex = asNumber(event.seatIndex);

  commit(draft, seatIndex, asNumber(event.committedThisRound) ?? 0, {
    allIn: event.allIn === true,
    acted: true,
    folded: action === 'FOLD',
  });

  if (action === 'BET' || action === 'RAISE') {
    draft.state = { ...draft.state, lastAggressorSeat: seatIndex };
  }
}

/**
 * The clock ran out. The server says which action it turned into, and it is
 * applied as if the player had chosen it — because as far as the table is
 * concerned, they did. A CHECK moves no chips, so the seat's total is unchanged.
 */
function actionTimedOut(draft: Draft, event: TableEvent): void {
  const seatIndex = asNumber(event.seatIndex);
  const seat = seatAt(draft, seatIndex);
  if (!seat) {
    draft.resyncNeeded = true;
    return;
  }

  commit(draft, seatIndex, seat.committedThisRound, {
    allIn: false,
    acted: true,
    folded: asString(event.appliedAction) === 'FOLD',
  });
}

function boardDealt(draft: Draft, event: TableEvent): void {
  const cards = asCards(event.cards);
  if (cards === null) {
    draft.resyncNeeded = true;
    return;
  }
  draft.state = { ...draft.state, board: [...draft.state.board, ...cards] };
}

function phaseChanged(draft: Draft, event: TableEvent): void {
  const to = asPhase(event.to);
  if (to === null) {
    draft.resyncNeeded = true;
    return;
  }

  // Chips are swept when a street closes, so a phase that opens a new street
  // must find the felt already clear — whether or not BETTING_ROUND_ENDED came
  // in the same patch.
  if (to === 'flop' || to === 'turn' || to === 'river' || to === 'showdown') sweep(draft);

  draft.phaseChanged = true;
  draft.state = { ...draft.state, phase: to };
}

/**
 * The one moment hole cards become public — and only because the server has
 * already decided they are. The client never turns a card over on its own.
 */
function handRevealed(draft: Draft, event: TableEvent): void {
  const cards = asCards(event.cards);
  if (cards === null) {
    draft.resyncNeeded = true;
    return;
  }

  updateSeat(draft, asNumber(event.seatIndex), (seat) => ({
    ...seat,
    holeCards: cards,
    cardCount: cards.length,
  }));
}

/**
 * A hand that reached the showdown and was not turned over.
 *
 * The event carries no cards and never will, so there is nothing to write to the
 * seat: what changes is that the table now knows this seat mucked, which is what
 * lets its owner be offered a Show button and everyone else be shown a face-down
 * pair rather than a hand that quietly never resolved.
 */
function handMucked(draft: Draft, event: TableEvent): void {
  const seatIndex = asNumber(event.seatIndex);
  if (seatIndex === null) {
    draft.resyncNeeded = true;
    return;
  }
  if (draft.state.muckedSeats.includes(seatIndex)) return;

  draft.state = { ...draft.state, muckedSeats: [...draft.state.muckedSeats, seatIndex].sort() };
}

function sittingOutChanged(draft: Draft, event: TableEvent): void {
  const sittingOut = event.sittingOut === true;
  updateSeat(draft, asNumber(event.seatIndex), (seat) => ({
    ...seat,
    sittingOut,
    // "Will be dealt the next hand", the same way the server works it out.
    isReady: !sittingOut && seat.stack > 0,
  }));
}

function potAwarded(draft: Draft, event: TableEvent): void {
  const amount = asNumber(event.amount) ?? 0;

  updateSeat(draft, asNumber(event.seatIndex), (seat) => ({ ...seat, stack: seat.stack + amount }));
  draft.awarded += amount;
}

/**
 * A seat's total for this street becomes `total`.
 *
 * The chips to get there came out of that seat's stack: that is not a rule being
 * re-derived, it is the same fact stated from the other side. Everything else —
 * whether the bet was legal, whether it reopened the action — stays the
 * server's.
 */
function commit(
  draft: Draft,
  seatIndex: number | null,
  total: number,
  flags: { allIn: boolean; acted: boolean; folded?: boolean },
): void {
  updateSeat(draft, seatIndex, (seat) => {
    const delta = Math.max(0, total - seat.committedThisRound);
    return {
      ...seat,
      stack: Math.max(0, seat.stack - delta),
      committedThisRound: total,
      committedThisHand: seat.committedThisHand + delta,
      hasActedThisRound: flags.acted,
      status: flags.folded === true ? 'folded' : flags.allIn ? 'allin' : seat.status,
    };
  });

  draft.state = { ...draft.state, currentBet: Math.max(draft.state.currentBet, total) };
}

/**
 * The street closed: the chips in front of each seat go into the middle.
 *
 * `committedThisHand` deliberately survives this — it is what the pot is made
 * of, and zeroing it here would make the total drop between streets.
 */
function sweep(draft: Draft): void {
  draft.seats = draft.seats.map((seat) =>
    seat === null || seat.committedThisRound === 0
      ? seat
      : { ...seat, committedThisRound: 0, hasActedThisRound: false },
  );

  draft.state = { ...draft.state, currentBet: 0, toActSeat: null };
}

function seatAt(draft: Draft, seatIndex: number | null): PublicSeat | null {
  if (seatIndex === null) return null;
  return draft.seats[seatIndex] ?? null;
}

function updateSeat(
  draft: Draft,
  seatIndex: number | null,
  update: (seat: PublicSeat) => PublicSeat,
): void {
  const seat = seatAt(draft, seatIndex);
  if (seat === null) {
    draft.resyncNeeded = true;
    return;
  }
  draft.seats = draft.seats.map((candidate, index) =>
    index === seatIndex && candidate !== null ? update(candidate) : candidate,
  );
}

/* ------------------------------------------------------------------ *
 * Reading untyped event fields                                        *
 *                                                                     *
 * A `TableEvent` is `{ type: string; [key: string]: unknown }` on the  *
 * wire, so every field is checked before it is believed.               *
 * ------------------------------------------------------------------ */

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asNumberArray(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is number => typeof item === 'number');
}

const PHASES: readonly Phase[] = [
  'waiting',
  'hand_start',
  'preflop',
  'flop',
  'turn',
  'river',
  'showdown',
  'payout',
  'hand_end',
];

function asPhase(value: unknown): Phase | null {
  return PHASES.find((candidate) => candidate === value) ?? null;
}

function asCards(value: unknown): Card[] | null {
  if (!Array.isArray(value)) return null;
  const cards: Card[] = [];

  for (const item of value) {
    if (typeof item !== 'object' || item === null) return null;
    const { rank, suit } = item as { rank?: unknown; suit?: unknown };
    if (typeof rank !== 'number') return null;
    if (suit !== 's' && suit !== 'h' && suit !== 'd' && suit !== 'c') return null;
    cards.push({ rank, suit });
  }

  return cards;
}
