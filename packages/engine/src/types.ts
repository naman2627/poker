/**
 * The vocabulary of a Texas Hold'em table.
 *
 * Everything here is data: plain, structurally typed, readonly where it matters.
 * `reduce()` never mutates a value it was handed — it returns a new
 * `TableState`. Nothing in this file knows about sockets, storage or time.
 */

// Type-only, and deliberately the one edge that points back at hand-eval: the
// category of a made hand is that file's vocabulary, and a showdown event has to
// be able to say it. Erased at compile time, so nothing circular survives.
import type { HandCategory } from './hand-eval';

export type Suit = 's' | 'h' | 'd' | 'c';

/** 2..10 are pip cards; 11=J, 12=Q, 13=K, 14=A. Aces are high here. */
export type Rank = 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14;

export const SUITS: readonly Suit[] = ['s', 'h', 'd', 'c'];
export const RANKS: readonly Rank[] = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];

export interface Card {
  readonly rank: Rank;
  readonly suit: Suit;
}

/**
 * `waiting`    — no hand in progress; players may sit, leave and rebuy.
 * `hand_start` — button and blinds are set, deck is shuffled, nothing dealt.
 * `preflop`..`river` — a betting round is open, or has just closed.
 * `showdown`   — cards are down; comparing them is the next phase of work.
 * `payout`     — pots are final and being awarded.
 * `hand_end`   — the hand is settled; the next START_HAND may begin.
 */
export type Phase =
  | 'waiting'
  | 'hand_start'
  | 'preflop'
  | 'flop'
  | 'turn'
  | 'river'
  | 'showdown'
  | 'payout'
  | 'hand_end';

/** The betting streets, in order. */
export const STREETS = ['preflop', 'flop', 'turn', 'river'] as const;
export type Street = (typeof STREETS)[number];

/**
 * `active`      — in the hand and still able to act.
 * `folded`      — out of this hand; chips already committed stay in the pot.
 * `allin`       — in the hand, no chips left, cannot act again.
 * `sitting_out` — seated but not part of the current hand.
 */
export type SeatStatus = 'active' | 'folded' | 'allin' | 'sitting_out';

export interface Seat {
  readonly seatIndex: number;
  readonly playerId: string;
  readonly stack: number;
  readonly status: SeatStatus;
  /**
   * "Deal me out." Sticky across hands, unlike `status`, which START_HAND
   * recomputes: a player who steps away stays out until they say otherwise.
   * A seat with no chips is not dealt in either, but that is not this flag —
   * which is why a rebuy puts a busted player straight back into the next hand.
   */
  readonly sittingOut: boolean;
  /** Owned by this seat until a showdown makes them public. See CLAUDE.md rule 1. */
  readonly holeCards: readonly Card[];
  /** Chips pushed forward on the current street. */
  readonly committedThisRound: number;
  /** Chips pushed forward since the hand began, blinds included. */
  readonly committedThisHand: number;
  /**
   * Has this seat acted since the last full bet or raise? A bet or a full raise
   * clears it for everyone else, which is what gives them a turn to respond, and
   * what gives the big blind their option preflop.
   */
  readonly hasActedThisRound: boolean;
}

/**
 * One layer of the pot. `eligibleSeats` are the seats that can win it: everyone
 * who paid into that layer and has not folded.
 */
export interface Pot {
  readonly amount: number;
  readonly eligibleSeats: readonly number[];
}

export interface TableState {
  /** Null until the first hand starts. */
  readonly handId: string | null;
  readonly handNumber: number;
  readonly phase: Phase;
  readonly buttonSeat: number | null;
  readonly sbSeat: number | null;
  readonly bbSeat: number | null;
  readonly smallBlind: number;
  readonly bigBlind: number;
  /** Undealt cards, front first. Server-only: never leaves through redactFor(). */
  readonly deck: readonly Card[];
  readonly board: readonly Card[];
  /** Fixed length; `null` is an empty seat. The index is the seat number. */
  readonly seats: readonly (Seat | null)[];
  /** What each active seat must have committed this round to continue. */
  readonly currentBet: number;
  /** Size of the last full raise; the floor for the next one. */
  readonly minRaise: number;
  readonly lastAggressorSeat: number | null;
  /** Whose turn it is, or null when no one may act right now. */
  readonly toActSeat: number | null;
  readonly pots: readonly Pot[];
  /**
   * Seats dealt into the most recent hand. The button advances to the next seat
   * in here, which is what keeps a dead button dead when someone leaves.
   */
  readonly dealtInSeats: readonly number[];
  /** Seats that asked to leave mid-hand; vacated when the hand ends. */
  readonly pendingLeave: readonly number[];
}

export interface TableConfig {
  readonly seatCount: number;
  readonly smallBlind: number;
  readonly bigBlind: number;
}

/**
 * `amount` on BET and RAISE is the total this seat will have committed on this
 * street once the action is applied: a raise *to*, not a raise *by*.
 */
export type PlayerActionInput =
  | { readonly type: 'FOLD' }
  | { readonly type: 'CHECK' }
  | { readonly type: 'CALL' }
  | { readonly type: 'BET'; readonly amount: number }
  | { readonly type: 'RAISE'; readonly amount: number }
  | { readonly type: 'ALL_IN' };

export type PlayerActionType = PlayerActionInput['type'];

export type Command =
  | {
      readonly type: 'SIT';
      readonly seatIndex: number;
      readonly playerId: string;
      readonly stack: number;
    }
  | { readonly type: 'LEAVE'; readonly seatIndex: number }
  | {
      readonly type: 'SET_SITTING_OUT';
      readonly seatIndex: number;
      readonly sittingOut: boolean;
    }
  | { readonly type: 'REBUY'; readonly seatIndex: number; readonly amount: number }
  | { readonly type: 'START_HAND'; readonly handId: string }
  | { readonly type: 'POST_BLINDS' }
  | { readonly type: 'DEAL_HOLE' }
  | {
      readonly type: 'PLAYER_ACTION';
      readonly seatIndex: number;
      readonly action: PlayerActionInput;
    }
  | { readonly type: 'ADVANCE_STREET' }
  /** `now` is supplied by the caller: the engine never reads the clock. */
  | { readonly type: 'TIMEOUT'; readonly seatIndex: number; readonly now: number };

export type CommandType = Command['type'];

/**
 * Events describe what just happened, for a transport to fan out. They carry no
 * hole cards: what a client may see is decided by the server's redactFor().
 */
export type EngineEvent =
  | {
      readonly type: 'PLAYER_SAT';
      readonly seatIndex: number;
      readonly playerId: string;
      readonly stack: number;
    }
  | { readonly type: 'PLAYER_LEFT'; readonly seatIndex: number; readonly playerId: string }
  | { readonly type: 'PLAYER_LEAVE_PENDING'; readonly seatIndex: number; readonly playerId: string }
  | {
      readonly type: 'PLAYER_SITTING_OUT_CHANGED';
      readonly seatIndex: number;
      readonly sittingOut: boolean;
    }
  | {
      readonly type: 'PLAYER_REBOUGHT';
      readonly seatIndex: number;
      readonly amount: number;
      readonly stack: number;
    }
  | {
      readonly type: 'HAND_STARTED';
      readonly handId: string;
      readonly handNumber: number;
      readonly buttonSeat: number;
      readonly sbSeat: number;
      readonly bbSeat: number;
      readonly dealtInSeats: readonly number[];
    }
  | {
      readonly type: 'BLIND_POSTED';
      readonly seatIndex: number;
      readonly blind: 'small' | 'big';
      readonly amount: number;
      readonly allIn: boolean;
    }
  | {
      readonly type: 'HOLE_CARDS_DEALT';
      readonly seats: readonly number[];
      readonly cardsPerSeat: number;
    }
  | {
      readonly type: 'PLAYER_ACTED';
      readonly seatIndex: number;
      readonly action: PlayerActionType;
      /** Total committed on this street after the action. */
      readonly committedThisRound: number;
      readonly allIn: boolean;
    }
  | {
      readonly type: 'ACTION_TIMED_OUT';
      readonly seatIndex: number;
      readonly now: number;
      readonly appliedAction: 'CHECK' | 'FOLD';
    }
  | { readonly type: 'ACTION_ON'; readonly seatIndex: number }
  | { readonly type: 'BETTING_ROUND_ENDED'; readonly phase: Phase }
  | {
      readonly type: 'BOARD_DEALT';
      readonly phase: 'flop' | 'turn' | 'river';
      readonly cards: readonly Card[];
    }
  | { readonly type: 'PHASE_CHANGED'; readonly from: Phase; readonly to: Phase }
  | { readonly type: 'SHOWDOWN_REACHED'; readonly seats: readonly number[] }
  | {
      readonly type: 'HAND_REVEALED';
      readonly seatIndex: number;
      /** Public once a contested showdown is reached, and not a moment before. */
      readonly cards: readonly Card[];
      readonly handName: string;
      /**
       * The same hand as a category rather than a sentence: `FULL_HOUSE` beside
       * "Kings full of threes". It says nothing the name does not already say —
       * it is the one form a counter can compare, which is what the lifetime
       * "best hand" statistic is made of.
       */
      readonly category: HandCategory;
      /** Position in the showdown order: 0 shows first. */
      readonly order: number;
    }
  /**
   * A hand that reached a showdown and was not turned over. It carries no cards
   * and never will: a mucked hand stays the owner's until they choose to show
   * it, which is a separate act the server records.
   */
  | { readonly type: 'HAND_MUCKED'; readonly seatIndex: number; readonly order: number }
  | {
      readonly type: 'POT_AWARDED';
      readonly seatIndex: number;
      readonly amount: number;
      readonly potIndex: number;
    }
  | { readonly type: 'HAND_ENDED'; readonly handNumber: number };

export type EngineEventType = EngineEvent['type'];

export interface ReduceResult {
  readonly state: TableState;
  readonly events: readonly EngineEvent[];
}

export interface LegalActions {
  readonly canFold: boolean;
  readonly canCheck: boolean;
  readonly canCall: boolean;
  /** What a call costs this seat; capped at its stack (an all-in call). */
  readonly callAmount: number;
  readonly canBet: boolean;
  readonly canRaise: boolean;
  /** Lowest legal total for a BET or RAISE; 0 when neither is available. */
  readonly minRaiseTo: number;
  /** Highest legal total: everything this seat has. 0 when neither is available. */
  readonly maxRaiseTo: number;
}
