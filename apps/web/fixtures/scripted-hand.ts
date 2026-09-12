import {
  SERVER_EVENTS,
  type ActionPromptPayload,
  type Card,
  type HandResultPayload,
  type LegalActions,
  type PublicSeat,
  type PublicTableState,
  type SeatStatus,
  type StatePatchPayload,
  type StateSyncPayload,
  type TableConfig,
  type TableEvent,
} from '@poker/shared';

/**
 * One recorded hand.
 *
 * This is a *recording*, not a simulation. Every number below — every stack,
 * every pot layer, every legal range — was worked out once, by hand, and written
 * down. Nothing here computes anything about poker, because a client that could
 * work out a side pot would be a client that had poker rules in it, and those
 * live in `packages/engine` and nowhere else (CLAUDE.md §2).
 *
 * What it buys: the whole interface is reviewable with no server, no database
 * and no SMS gateway running — `pnpm --filter @poker/web dev` and you are at a
 * table. And because the frames are exactly the frames the real server sends,
 * the store, the reducer and every component are the same code in both modes.
 *
 * The hand, in short:
 *   six seated at a nine-seat table, blinds 5/10, the viewer in seat 4
 *   Ines (seat 2) is short and gets all in on the flop, capping the main pot
 *   Priya (seat 0) and the viewer play on for a side pot
 *   Ines takes the main with trip nines; the viewer takes the side with two pair
 */

/* ------------------------------------------------------------------ *
 * The table                                                           *
 * ------------------------------------------------------------------ */

export const FIXTURE_TABLE_CODE = 'FELT42';

export const FIXTURE_CONFIG: TableConfig = {
  seatCount: 9,
  smallBlind: 5,
  bigBlind: 10,
  minBuyIn: 200,
  maxBuyIn: 2000,
  actionTimeoutSec: 30,
};

/** The seat the recording is told from. */
export const FIXTURE_VIEWER_SEAT = 4;
export const FIXTURE_VIEWER_USER_ID = '6b1f2a10-0000-4000-8000-000000000004';
export const FIXTURE_HAND_ID = 'a7c3d9e2-0000-4000-8000-00000000ab01';

interface Player {
  readonly seatIndex: number;
  readonly userId: string;
  readonly displayName: string;
  readonly avatarSeed: string;
  readonly startingStack: number;
}

const PLAYERS: readonly Player[] = [
  {
    seatIndex: 0,
    userId: '6b1f2a10-0000-4000-8000-000000000000',
    displayName: 'Priya',
    avatarSeed: 'nut-flush',
    startingStack: 1000,
  },
  {
    seatIndex: 1,
    userId: '6b1f2a10-0000-4000-8000-000000000001',
    displayName: 'Marcus',
    avatarSeed: 'dead-money',
    startingStack: 1000,
  },
  {
    seatIndex: 2,
    userId: '6b1f2a10-0000-4000-8000-000000000002',
    displayName: 'Ines',
    avatarSeed: 'river-rat',
    startingStack: 165,
  },
  {
    seatIndex: FIXTURE_VIEWER_SEAT,
    userId: FIXTURE_VIEWER_USER_ID,
    displayName: 'Naman',
    avatarSeed: 'ace-of-spades',
    startingStack: 1000,
  },
  {
    seatIndex: 6,
    userId: '6b1f2a10-0000-4000-8000-000000000006',
    displayName: 'Tobias',
    avatarSeed: 'the-button',
    startingStack: 1000,
  },
  {
    seatIndex: 7,
    userId: '6b1f2a10-0000-4000-8000-000000000007',
    displayName: 'Ada',
    avatarSeed: 'gutshot',
    startingStack: 1000,
  },
];

const DEALT_IN = PLAYERS.map((player) => player.seatIndex);

/* ------------------------------------------------------------------ *
 * The cards                                                           *
 * ------------------------------------------------------------------ */

const card = (rank: number, suit: Card['suit']): Card => ({ rank, suit });

const FLOP: readonly Card[] = [card(13, 's'), card(9, 'h'), card(4, 'd')];
const TURN: readonly Card[] = [card(12, 'c')];
const RIVER: readonly Card[] = [card(9, 'd')];
const BOARD = [...FLOP, ...TURN, ...RIVER];

/** The viewer's own hand, which arrives on `hand:dealt` and nowhere else. */
export const VIEWER_HOLE_CARDS: readonly Card[] = [card(13, 'd'), card(12, 'h')];

const INES_HOLE_CARDS: readonly Card[] = [card(14, 'h'), card(9, 'c')];
const PRIYA_HOLE_CARDS: readonly Card[] = [card(14, 's'), card(13, 'h')];

/* ------------------------------------------------------------------ *
 * Frames                                                              *
 * ------------------------------------------------------------------ */

/**
 * Stamped with the wall clock at replay time. The action clock is absolute epoch
 * milliseconds on the wire so a client's own clock cannot shorten or lengthen a
 * turn — which means a recording cannot carry a real one, only a mark saying
 * "put the current deadline here".
 */
export const DEADLINE = -1;

export interface ScriptFrame {
  /** Milliseconds after the previous frame. */
  readonly delayMs: number;
  readonly event: string;
  readonly payload: unknown;
  /**
   * When set, the replay holds here until the viewer does something. The frame
   * is what the recording says happened next — shown in the fixture bar before
   * they click, so nobody is surprised by a line they did not choose.
   */
  readonly waitFor?: {
    readonly clientEvent: string;
    readonly label: string;
  };
}

const sync = (version: number, state: PublicTableState): ScriptFrame['payload'] =>
  ({ version, state }) satisfies StateSyncPayload;

const patch = (version: number, events: readonly TableEvent[]): ScriptFrame['payload'] =>
  ({ version, events }) satisfies StatePatchPayload;

const prompt = (
  seatIndex: number,
  actionSeq: number,
  legalActions: LegalActions,
): ScriptFrame['payload'] =>
  ({
    handId: FIXTURE_HAND_ID,
    seatIndex,
    actionSeq,
    legalActions,
    deadlineTs: DEADLINE,
  }) satisfies ActionPromptPayload;

/** A seat, spelled out. Every field is a literal from the worked-out hand. */
interface SeatSpec {
  readonly stack: number;
  readonly status: SeatStatus;
  readonly committedThisRound: number;
  readonly committedThisHand: number;
  readonly cardCount: number;
  readonly holeCards?: readonly Card[];
  readonly isReady?: boolean;
}

function seats(specs: Readonly<Record<number, SeatSpec>>): (PublicSeat | null)[] {
  const row: (PublicSeat | null)[] = Array.from({ length: FIXTURE_CONFIG.seatCount }, () => null);

  for (const player of PLAYERS) {
    const spec = specs[player.seatIndex];
    if (!spec) continue;

    row[player.seatIndex] = {
      seatIndex: player.seatIndex,
      userId: player.userId,
      displayName: player.displayName,
      avatarSeed: player.avatarSeed,
      stack: spec.stack,
      status: spec.status,
      committedThisRound: spec.committedThisRound,
      committedThisHand: spec.committedThisHand,
      hasActedThisRound: false,
      cardCount: spec.cardCount,
      holeCards: spec.holeCards === undefined ? null : [...spec.holeCards],
      isReady: spec.isReady ?? false,
      sittingOut: !(spec.isReady ?? false),
      leaving: false,
    };
  }

  return row;
}

interface TableSpec {
  readonly phase: PublicTableState['phase'];
  readonly handId: string | null;
  readonly handNumber: number;
  readonly buttonSeat: number | null;
  readonly board: readonly Card[];
  readonly seats: (PublicSeat | null)[];
  readonly currentBet: number;
  readonly minRaise: number;
  readonly toActSeat: number | null;
  readonly pots: PublicTableState['pots'];
  readonly deckRemaining: number;
  readonly onTheClock: boolean;
}

function table(spec: TableSpec): PublicTableState {
  const inHand = spec.handId !== null;

  return {
    tableCode: FIXTURE_TABLE_CODE,
    handId: spec.handId,
    handNumber: spec.handNumber,
    phase: spec.phase,
    buttonSeat: spec.buttonSeat,
    sbSeat: inHand ? 0 : null,
    bbSeat: inHand ? 1 : null,
    smallBlind: FIXTURE_CONFIG.smallBlind,
    bigBlind: FIXTURE_CONFIG.bigBlind,
    board: [...spec.board],
    seats: spec.seats,
    currentBet: spec.currentBet,
    minRaise: spec.minRaise,
    lastAggressorSeat: null,
    toActSeat: spec.toActSeat,
    pots: spec.pots,
    deckRemaining: spec.deckRemaining,
    actionDeadlineTs: spec.onTheClock ? DEADLINE : null,
    viewerSeatIndex: FIXTURE_VIEWER_SEAT,
    hostUserId: FIXTURE_VIEWER_USER_ID,
    paused: false,
    // A recording, so the commitment is a recorded one too. The seed behind it
    // is not in the fixture: a recording has no deck to open.
    deckCommit: inHand ? 'f'.repeat(64) : null,
    muckedSeats: [],
    // A recording has no sitting to count, so the board carries stacks and
    // nothing else. The patches that follow move those stacks; see `applyPatch`.
    leaderboard: spec.seats.flatMap((seat) =>
      seat === null
        ? []
        : [
            {
              seatIndex: seat.seatIndex,
              userId: seat.userId,
              displayName: seat.displayName,
              avatarSeed: seat.avatarSeed,
              stack: seat.stack,
              net: 0,
              handsWon: 0,
              biggestPot: 0,
            },
          ],
    ),
  };
}

const legal = (over: Partial<LegalActions>): LegalActions => ({
  canFold: true,
  canCheck: false,
  canCall: false,
  callAmount: 0,
  canBet: false,
  canRaise: false,
  minRaiseTo: 0,
  maxRaiseTo: 0,
  ...over,
});

/* ------------------------------------------------------------------ *
 * The states, at the four moments a whole one is sent                 *
 * ------------------------------------------------------------------ */

/** Nobody is in a hand yet; the table is waiting for everyone to say they are in. */
const WAITING = table({
  phase: 'waiting',
  handId: null,
  handNumber: 0,
  buttonSeat: null,
  board: [],
  currentBet: 0,
  minRaise: FIXTURE_CONFIG.bigBlind,
  toActSeat: null,
  pots: [],
  deckRemaining: 52,
  onTheClock: false,
  seats: seats({
    0: idle(1000, true),
    1: idle(1000, true),
    2: idle(165, true),
    4: idle(1000, false),
    6: idle(1000, true),
    7: idle(1000, true),
  }),
});

function idle(stack: number, isReady: boolean): SeatSpec {
  return {
    stack,
    status: 'active',
    committedThisRound: 0,
    committedThisHand: 0,
    cardCount: 0,
    isReady,
  };
}

/** Blinds are in, cards are out, and seat 2 is first to act. */
const PREFLOP = table({
  phase: 'preflop',
  handId: FIXTURE_HAND_ID,
  handNumber: 1,
  buttonSeat: 7,
  board: [],
  currentBet: 10,
  minRaise: 10,
  toActSeat: 2,
  // Only the blinds are in, so the whole pot is owed to the two seats that put
  // them there. See buildPots in packages/engine.
  pots: [{ amount: 15, eligibleSeats: [0, 1] }],
  deckRemaining: 40,
  onTheClock: false,
  seats: seats({
    0: inHand(995, 5, 5),
    1: inHand(990, 10, 10),
    2: inHand(165, 0, 0),
    4: inHand(1000, 0, 0),
    6: inHand(1000, 0, 0),
    7: inHand(1000, 0, 0),
  }),
});

function inHand(stack: number, thisRound: number, thisHand: number): SeatSpec {
  return {
    stack,
    status: 'active',
    committedThisRound: thisRound,
    committedThisHand: thisHand,
    cardCount: 2,
    isReady: true,
  };
}

/**
 * The flop is out. Marcus, Tobias and Ada are gone; the 100 in the middle is one
 * pot because everyone still in it paid the same into every layer.
 */
const FLOP_STATE = table({
  phase: 'flop',
  handId: FIXTURE_HAND_ID,
  handNumber: 1,
  buttonSeat: 7,
  board: FLOP,
  currentBet: 0,
  minRaise: 10,
  toActSeat: 0,
  pots: [{ amount: 100, eligibleSeats: [0, 2, 4] }],
  deckRemaining: 37,
  onTheClock: true,
  seats: seats({
    0: { ...inHand(970, 0, 30) },
    1: folded(990, 10),
    2: { ...inHand(135, 0, 30) },
    4: { ...inHand(970, 0, 30) },
    6: folded(1000, 0),
    7: folded(1000, 0),
  }),
});

function folded(stack: number, thisHand: number): SeatSpec {
  return {
    stack,
    status: 'folded',
    committedThisRound: 0,
    committedThisHand: thisHand,
    cardCount: 0,
    isReady: true,
  };
}

/**
 * Ines is all in for 165 total, so the main pot is capped there and everything
 * Priya and the viewer put in above it starts a side pot only they can win.
 */
const TURN_STATE = table({
  phase: 'turn',
  handId: FIXTURE_HAND_ID,
  handNumber: 1,
  buttonSeat: 7,
  board: [...FLOP, ...TURN],
  currentBet: 0,
  minRaise: 10,
  toActSeat: 0,
  pots: [
    { amount: 505, eligibleSeats: [0, 2, 4] },
    { amount: 30, eligibleSeats: [0, 4] },
  ],
  deckRemaining: 36,
  onTheClock: true,
  seats: seats({
    0: { ...inHand(820, 0, 180) },
    1: folded(990, 10),
    2: { ...inHand(0, 0, 165), status: 'allin' },
    4: { ...inHand(820, 0, 180) },
    6: folded(1000, 0),
    7: folded(1000, 0),
  }),
});

const RIVER_STATE = table({
  phase: 'river',
  handId: FIXTURE_HAND_ID,
  handNumber: 1,
  buttonSeat: 7,
  board: BOARD,
  currentBet: 0,
  minRaise: 10,
  toActSeat: 0,
  pots: [
    { amount: 505, eligibleSeats: [0, 2, 4] },
    { amount: 430, eligibleSeats: [0, 4] },
  ],
  deckRemaining: 35,
  onTheClock: true,
  seats: seats({
    0: { ...inHand(620, 0, 380) },
    1: folded(990, 10),
    2: { ...inHand(0, 0, 165), status: 'allin' },
    4: { ...inHand(620, 0, 380) },
    6: folded(1000, 0),
    7: folded(1000, 0),
  }),
});

/** Settled. The pots are gone, and the three hands that were shown stay face up. */
const SETTLED = table({
  phase: 'hand_end',
  handId: FIXTURE_HAND_ID,
  handNumber: 1,
  buttonSeat: 7,
  board: BOARD,
  currentBet: 0,
  minRaise: 10,
  toActSeat: null,
  pots: [],
  deckRemaining: 35,
  onTheClock: false,
  seats: seats({
    0: { ...shown(620, PRIYA_HOLE_CARDS) },
    1: folded(990, 0),
    2: { ...shown(505, INES_HOLE_CARDS) },
    4: { ...shown(1050, VIEWER_HOLE_CARDS) },
    6: folded(1000, 0),
    7: folded(1000, 0),
  }),
});

function shown(stack: number, holeCards: readonly Card[]): SeatSpec {
  return {
    stack,
    status: 'active',
    committedThisRound: 0,
    committedThisHand: 0,
    cardCount: 2,
    holeCards,
    isReady: false,
  };
}

const HAND_RESULT: HandResultPayload = {
  handId: FIXTURE_HAND_ID,
  pots: [
    { amount: 505, eligibleSeats: [0, 2, 4] },
    { amount: 430, eligibleSeats: [0, 4] },
  ],
  awards: [
    { seatIndex: 2, amount: 505, potIndex: 0 },
    { seatIndex: 4, amount: 430, potIndex: 1 },
  ],
  revealed: [
    { seatIndex: 2, cards: INES_HOLE_CARDS, handName: 'Three of a kind, nines', order: 0 },
    { seatIndex: 0, cards: PRIYA_HOLE_CARDS, handName: 'Two pair, kings and nines', order: 1 },
    { seatIndex: 4, cards: VIEWER_HOLE_CARDS, handName: 'Two pair, kings and queens', order: 2 },
  ],
  mucked: [],
};

/* ------------------------------------------------------------------ *
 * The script                                                          *
 * ------------------------------------------------------------------ */

/**
 * Seat 2's options when the action opens on her: the big blind is 10 and she has
 * 165 behind, so she may fold, call 10, or raise anywhere from 20 to all of it.
 */
const INES_OPENS = legal({
  canCall: true,
  callAmount: 10,
  canRaise: true,
  minRaiseTo: 20,
  maxRaiseTo: 165,
});

const acted = (
  seatIndex: number,
  action: string,
  committedThisRound: number,
  allIn = false,
): TableEvent => ({ type: 'PLAYER_ACTED', seatIndex, action, committedThisRound, allIn });

const actionOn = (seatIndex: number): TableEvent => ({ type: 'ACTION_ON', seatIndex });

export const SCRIPT: readonly ScriptFrame[] = [
  { delayMs: 200, event: SERVER_EVENTS.stateSync, payload: sync(0, WAITING) },

  /* --- the hand begins, once the viewer says they are in --- */
  {
    delayMs: 500,
    event: SERVER_EVENTS.stateSync,
    payload: sync(1, PREFLOP),
    waitFor: { clientEvent: 'player:ready', label: 'Deal the recorded hand' },
  },
  {
    delayMs: 60,
    event: SERVER_EVENTS.statePatch,
    payload: patch(1, [
      {
        type: 'HAND_STARTED',
        handId: FIXTURE_HAND_ID,
        handNumber: 1,
        buttonSeat: 7,
        sbSeat: 0,
        bbSeat: 1,
        dealtInSeats: DEALT_IN,
      },
      { type: 'BLIND_POSTED', seatIndex: 0, blind: 'small', amount: 5, allIn: false },
      { type: 'BLIND_POSTED', seatIndex: 1, blind: 'big', amount: 10, allIn: false },
      { type: 'HOLE_CARDS_DEALT', seats: DEALT_IN, cardsPerSeat: 2 },
      { type: 'PHASE_CHANGED', from: 'hand_start', to: 'preflop' },
      actionOn(2),
    ]),
  },
  {
    delayMs: 400,
    event: SERVER_EVENTS.handDealt,
    payload: {
      handId: FIXTURE_HAND_ID,
      seatIndex: FIXTURE_VIEWER_SEAT,
      yourCards: VIEWER_HOLE_CARDS,
    },
  },
  { delayMs: 120, event: SERVER_EVENTS.actionPrompt, payload: prompt(2, 0, INES_OPENS) },

  /* --- preflop --- */
  {
    delayMs: 1400,
    event: SERVER_EVENTS.statePatch,
    payload: patch(2, [acted(2, 'RAISE', 30), actionOn(FIXTURE_VIEWER_SEAT)]),
  },
  {
    delayMs: 120,
    event: SERVER_EVENTS.actionPrompt,
    payload: prompt(
      FIXTURE_VIEWER_SEAT,
      1,
      legal({ canCall: true, callAmount: 30, canRaise: true, minRaiseTo: 50, maxRaiseTo: 1000 }),
    ),
  },
  {
    delayMs: 200,
    event: SERVER_EVENTS.statePatch,
    payload: patch(3, [acted(FIXTURE_VIEWER_SEAT, 'CALL', 30), actionOn(6)]),
    waitFor: { clientEvent: 'player:action', label: 'Naman calls 30' },
  },
  {
    delayMs: 120,
    event: SERVER_EVENTS.actionPrompt,
    payload: prompt(
      6,
      2,
      legal({ canCall: true, callAmount: 30, canRaise: true, minRaiseTo: 50, maxRaiseTo: 1000 }),
    ),
  },
  {
    delayMs: 900,
    event: SERVER_EVENTS.statePatch,
    payload: patch(4, [acted(6, 'FOLD', 0), actionOn(7)]),
  },
  {
    delayMs: 120,
    event: SERVER_EVENTS.actionPrompt,
    payload: prompt(
      7,
      3,
      legal({ canCall: true, callAmount: 30, canRaise: true, minRaiseTo: 50, maxRaiseTo: 1000 }),
    ),
  },
  {
    delayMs: 800,
    event: SERVER_EVENTS.statePatch,
    payload: patch(5, [acted(7, 'FOLD', 0), actionOn(0)]),
  },
  {
    delayMs: 120,
    event: SERVER_EVENTS.actionPrompt,
    payload: prompt(
      0,
      4,
      legal({ canCall: true, callAmount: 25, canRaise: true, minRaiseTo: 50, maxRaiseTo: 1000 }),
    ),
  },
  {
    delayMs: 1100,
    event: SERVER_EVENTS.statePatch,
    payload: patch(6, [acted(0, 'CALL', 30), actionOn(1)]),
  },
  {
    delayMs: 120,
    event: SERVER_EVENTS.actionPrompt,
    payload: prompt(
      1,
      5,
      legal({ canCall: true, callAmount: 20, canRaise: true, minRaiseTo: 50, maxRaiseTo: 1000 }),
    ),
  },

  /* --- flop --- */
  {
    delayMs: 1200,
    event: SERVER_EVENTS.statePatch,
    payload: patch(7, [
      acted(1, 'FOLD', 10),
      { type: 'BETTING_ROUND_ENDED', phase: 'preflop' },
      { type: 'PHASE_CHANGED', from: 'preflop', to: 'flop' },
      { type: 'BOARD_DEALT', phase: 'flop', cards: FLOP },
      actionOn(0),
    ]),
  },
  { delayMs: 80, event: SERVER_EVENTS.stateSync, payload: sync(7, FLOP_STATE) },
  {
    delayMs: 700,
    event: SERVER_EVENTS.actionPrompt,
    payload: prompt(0, 6, legal({ canCheck: true, canBet: true, minRaiseTo: 10, maxRaiseTo: 970 })),
  },
  {
    delayMs: 1300,
    event: SERVER_EVENTS.statePatch,
    payload: patch(8, [acted(0, 'CHECK', 0), actionOn(2)]),
  },
  {
    delayMs: 120,
    event: SERVER_EVENTS.actionPrompt,
    payload: prompt(2, 7, legal({ canCheck: true, canBet: true, minRaiseTo: 10, maxRaiseTo: 135 })),
  },
  {
    delayMs: 1500,
    event: SERVER_EVENTS.statePatch,
    payload: patch(9, [acted(2, 'BET', 60), actionOn(FIXTURE_VIEWER_SEAT)]),
  },
  {
    delayMs: 120,
    event: SERVER_EVENTS.actionPrompt,
    payload: prompt(
      FIXTURE_VIEWER_SEAT,
      8,
      legal({ canCall: true, callAmount: 60, canRaise: true, minRaiseTo: 120, maxRaiseTo: 970 }),
    ),
  },
  {
    delayMs: 200,
    event: SERVER_EVENTS.statePatch,
    payload: patch(10, [acted(FIXTURE_VIEWER_SEAT, 'RAISE', 150), actionOn(0)]),
    waitFor: { clientEvent: 'player:action', label: 'Naman raises to 150' },
  },
  {
    delayMs: 120,
    event: SERVER_EVENTS.actionPrompt,
    payload: prompt(
      0,
      9,
      legal({ canCall: true, callAmount: 150, canRaise: true, minRaiseTo: 240, maxRaiseTo: 970 }),
    ),
  },
  {
    delayMs: 1600,
    event: SERVER_EVENTS.statePatch,
    payload: patch(11, [acted(0, 'CALL', 150), actionOn(2)]),
  },
  {
    delayMs: 120,
    event: SERVER_EVENTS.actionPrompt,
    payload: prompt(2, 10, legal({ canCall: true, callAmount: 75, canRaise: false })),
  },

  /* --- turn: Ines is all in, so a side pot opens --- */
  {
    delayMs: 1500,
    event: SERVER_EVENTS.statePatch,
    payload: patch(12, [
      acted(2, 'ALL_IN', 135, true),
      { type: 'BETTING_ROUND_ENDED', phase: 'flop' },
      { type: 'PHASE_CHANGED', from: 'flop', to: 'turn' },
      { type: 'BOARD_DEALT', phase: 'turn', cards: TURN },
      actionOn(0),
    ]),
  },
  { delayMs: 80, event: SERVER_EVENTS.stateSync, payload: sync(12, TURN_STATE) },
  {
    delayMs: 700,
    event: SERVER_EVENTS.actionPrompt,
    payload: prompt(
      0,
      11,
      legal({ canCheck: true, canBet: true, minRaiseTo: 10, maxRaiseTo: 820 }),
    ),
  },
  {
    delayMs: 1400,
    event: SERVER_EVENTS.statePatch,
    payload: patch(13, [acted(0, 'CHECK', 0), actionOn(FIXTURE_VIEWER_SEAT)]),
  },
  {
    delayMs: 120,
    event: SERVER_EVENTS.actionPrompt,
    payload: prompt(
      FIXTURE_VIEWER_SEAT,
      12,
      legal({ canCheck: true, canBet: true, minRaiseTo: 10, maxRaiseTo: 820 }),
    ),
  },
  {
    delayMs: 200,
    event: SERVER_EVENTS.statePatch,
    payload: patch(14, [acted(FIXTURE_VIEWER_SEAT, 'BET', 200), actionOn(0)]),
    waitFor: { clientEvent: 'player:action', label: 'Naman bets 200' },
  },
  {
    delayMs: 120,
    event: SERVER_EVENTS.actionPrompt,
    payload: prompt(
      0,
      13,
      legal({ canCall: true, callAmount: 200, canRaise: true, minRaiseTo: 400, maxRaiseTo: 820 }),
    ),
  },

  /* --- river --- */
  {
    delayMs: 1500,
    event: SERVER_EVENTS.statePatch,
    payload: patch(15, [
      acted(0, 'CALL', 200),
      { type: 'BETTING_ROUND_ENDED', phase: 'turn' },
      { type: 'PHASE_CHANGED', from: 'turn', to: 'river' },
      { type: 'BOARD_DEALT', phase: 'river', cards: RIVER },
      actionOn(0),
    ]),
  },
  { delayMs: 80, event: SERVER_EVENTS.stateSync, payload: sync(15, RIVER_STATE) },
  {
    delayMs: 700,
    event: SERVER_EVENTS.actionPrompt,
    payload: prompt(
      0,
      14,
      legal({ canCheck: true, canBet: true, minRaiseTo: 10, maxRaiseTo: 620 }),
    ),
  },
  {
    delayMs: 1400,
    event: SERVER_EVENTS.statePatch,
    payload: patch(16, [acted(0, 'CHECK', 0), actionOn(FIXTURE_VIEWER_SEAT)]),
  },
  {
    delayMs: 120,
    event: SERVER_EVENTS.actionPrompt,
    payload: prompt(
      FIXTURE_VIEWER_SEAT,
      15,
      legal({ canCheck: true, canBet: true, minRaiseTo: 10, maxRaiseTo: 620 }),
    ),
  },

  /* --- showdown --- */
  {
    delayMs: 200,
    event: SERVER_EVENTS.statePatch,
    payload: patch(17, [
      acted(FIXTURE_VIEWER_SEAT, 'CHECK', 0),
      { type: 'BETTING_ROUND_ENDED', phase: 'river' },
      { type: 'PHASE_CHANGED', from: 'river', to: 'showdown' },
      { type: 'SHOWDOWN_REACHED', seats: [0, 2, 4] },
      {
        type: 'HAND_REVEALED',
        seatIndex: 2,
        cards: INES_HOLE_CARDS,
        handName: 'Three of a kind, nines',
        order: 0,
      },
      {
        type: 'HAND_REVEALED',
        seatIndex: 0,
        cards: PRIYA_HOLE_CARDS,
        handName: 'Two pair, kings and nines',
        order: 1,
      },
      {
        type: 'HAND_REVEALED',
        seatIndex: FIXTURE_VIEWER_SEAT,
        cards: VIEWER_HOLE_CARDS,
        handName: 'Two pair, kings and queens',
        order: 2,
      },
      { type: 'PHASE_CHANGED', from: 'showdown', to: 'payout' },
      { type: 'POT_AWARDED', seatIndex: 2, amount: 505, potIndex: 0 },
      { type: 'POT_AWARDED', seatIndex: FIXTURE_VIEWER_SEAT, amount: 430, potIndex: 1 },
      { type: 'PHASE_CHANGED', from: 'payout', to: 'hand_end' },
      { type: 'HAND_ENDED', handNumber: 1 },
    ]),
    waitFor: { clientEvent: 'player:action', label: 'Naman checks' },
  },
  { delayMs: 400, event: SERVER_EVENTS.handResult, payload: HAND_RESULT },
  { delayMs: 900, event: SERVER_EVENTS.stateSync, payload: sync(17, SETTLED) },
  {
    delayMs: 600,
    event: SERVER_EVENTS.chatMessage,
    payload: {
      userId: PLAYERS[2]?.userId ?? '',
      displayName: 'Ines',
      text: 'runs like a Swiss watch',
      at: 0,
    },
  },
];
