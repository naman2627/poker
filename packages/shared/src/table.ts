import { z } from 'zod';

/**
 * The table, as it travels over a socket.
 *
 * These types describe what a *client* is allowed to know. They are deliberately
 * not the engine's types: the engine's `TableState` holds the deck and every
 * seat's hole cards, and none of that may leave the server. The server's
 * `redactFor()` is the one function that turns one into the other.
 *
 * The card and pot shapes here are structurally identical to the engine's on
 * purpose — @poker/shared cannot import @poker/engine (the dependency runs the
 * other way), so the wire keeps its own copy of the vocabulary.
 */

export const SuitSchema = z.enum(['s', 'h', 'd', 'c']);
export type Suit = z.infer<typeof SuitSchema>;

export const CardSchema = z.object({
  rank: z.number().int().min(2).max(14),
  suit: SuitSchema,
});
export type Card = z.infer<typeof CardSchema>;

export const PhaseSchema = z.enum([
  'waiting',
  'hand_start',
  'preflop',
  'flop',
  'turn',
  'river',
  'showdown',
  'payout',
  'hand_end',
]);
export type Phase = z.infer<typeof PhaseSchema>;

export const SeatStatusSchema = z.enum(['active', 'folded', 'allin', 'sitting_out']);
export type SeatStatus = z.infer<typeof SeatStatusSchema>;

export const PotSchema = z.object({
  amount: z.number().int().nonnegative(),
  eligibleSeats: z.array(z.number().int().nonnegative()),
});
export type Pot = z.infer<typeof PotSchema>;

export const LegalActionsSchema = z.object({
  canFold: z.boolean(),
  canCheck: z.boolean(),
  canCall: z.boolean(),
  callAmount: z.number().int().nonnegative(),
  canBet: z.boolean(),
  canRaise: z.boolean(),
  minRaiseTo: z.number().int().nonnegative(),
  maxRaiseTo: z.number().int().nonnegative(),
});
export type LegalActions = z.infer<typeof LegalActionsSchema>;

/**
 * Table codes are six characters from an alphabet with no O, 0, I or 1, so a
 * code read down a phone line cannot be mistyped into somebody else's game.
 */
export const TABLE_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const TABLE_CODE_LENGTH = 6;
export const TableCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(
    new RegExp(`^[${TABLE_CODE_ALPHABET}]{${String(TABLE_CODE_LENGTH)}}$`),
    'that is not a table code',
  );

export const TableConfigSchema = z
  .object({
    seatCount: z.number().int().min(2).max(9).default(6),
    smallBlind: z.number().int().positive().default(5),
    bigBlind: z.number().int().positive().default(10),
    minBuyIn: z.number().int().positive().default(200),
    maxBuyIn: z.number().int().positive().default(2000),
    actionTimeoutSec: z.number().int().min(5).max(120).default(30),
  })
  .refine((config) => config.smallBlind <= config.bigBlind, {
    message: 'the small blind cannot exceed the big blind',
  })
  .refine((config) => config.minBuyIn <= config.maxBuyIn, {
    message: 'the minimum buy-in cannot exceed the maximum',
  })
  .refine((config) => config.minBuyIn >= config.bigBlind * 2, {
    message: 'the minimum buy-in must be at least two big blinds',
  });
export type TableConfig = z.infer<typeof TableConfigSchema>;

/**
 * One seat, as a client sees it.
 *
 * `holeCards` is null for everybody but the viewer, until a showdown makes them
 * public. `cardCount` is what a client draws face down.
 */
export const PublicSeatSchema = z.object({
  seatIndex: z.number().int().nonnegative(),
  userId: z.uuid(),
  displayName: z.string(),
  avatarSeed: z.string().nullable(),
  stack: z.number().int().nonnegative(),
  status: SeatStatusSchema,
  committedThisRound: z.number().int().nonnegative(),
  committedThisHand: z.number().int().nonnegative(),
  hasActedThisRound: z.boolean(),
  cardCount: z.number().int().min(0).max(2),
  holeCards: z.array(CardSchema).nullable(),
  isReady: z.boolean(),
  /** "Deal me out": true means this seat is not in the next hand. */
  sittingOut: z.boolean(),
  /** Asked to leave during a hand; the seat empties when the hand ends. */
  leaving: z.boolean(),
});
export type PublicSeat = z.infer<typeof PublicSeatSchema>;

/**
 * One row of the LIVE board — this table, this sitting.
 *
 * Everything here is derived from a `TableRuntime`'s memory and never written
 * down: `net`, `handsWon` and `biggestPot` count from the moment a player sat
 * in this seat, and standing up ends the count. The lifetime figures are a
 * different thing entirely and live in `stats.ts`.
 *
 * `net` is the only signed number on the table's wire: stack minus everything
 * bought in, so a player who bought in for 200 twice and is sitting behind 150
 * is at -250 and the board says so.
 */
export const LiveLeaderboardRowSchema = z.object({
  seatIndex: z.number().int().nonnegative(),
  userId: z.uuid(),
  displayName: z.string(),
  avatarSeed: z.string().nullable(),
  stack: z.number().int().nonnegative(),
  /** Signed: current stack minus buy-in and every rebuy since sitting down. */
  net: z.number().int(),
  handsWon: z.number().int().nonnegative(),
  biggestPot: z.number().int().nonnegative(),
});
export type LiveLeaderboardRow = z.infer<typeof LiveLeaderboardRowSchema>;

export const PublicTableStateSchema = z.object({
  tableCode: z.string(),
  handId: z.string().nullable(),
  handNumber: z.number().int().nonnegative(),
  phase: PhaseSchema,
  buttonSeat: z.number().int().nullable(),
  sbSeat: z.number().int().nullable(),
  bbSeat: z.number().int().nullable(),
  smallBlind: z.number().int().positive(),
  bigBlind: z.number().int().positive(),
  board: z.array(CardSchema),
  seats: z.array(PublicSeatSchema.nullable()),
  currentBet: z.number().int().nonnegative(),
  minRaise: z.number().int().nonnegative(),
  lastAggressorSeat: z.number().int().nullable(),
  toActSeat: z.number().int().nullable(),
  pots: z.array(PotSchema),
  /** How many cards are left undealt. The cards themselves never leave. */
  deckRemaining: z.number().int().nonnegative(),
  /** Absolute epoch milliseconds, so a client's own clock does not matter. */
  actionDeadlineTs: z.number().int().nullable(),
  /** The seat the viewer is sitting in, or null when watching. */
  viewerSeatIndex: z.number().int().nullable(),
  /**
   * Whoever created the table. They are the only one who can pause it, and a
   * paused table finishes the hand it is in and then deals no more.
   */
  hostUserId: z.uuid().nullable(),
  paused: z.boolean(),
  /**
   * sha256 of the seed this hand's deck was shuffled from, published before the
   * cards came out. The seed itself follows when the hand is over — see
   * `deck:revealed`. Null between hands.
   */
  deckCommit: z.string().nullable(),
  /** Seats that reached a showdown and mucked. Their cards are not here. */
  muckedSeats: z.array(z.number().int().nonnegative()),
  /**
   * The live board, biggest stack first. Recomputed from table memory every
   * time the table publishes anything, which is every time a stack moves.
   */
  leaderboard: z.array(LiveLeaderboardRowSchema),
});
export type PublicTableState = z.infer<typeof PublicTableStateSchema>;

/* ------------------------------------------------------------------ *
 * Client -> server                                                    *
 * ------------------------------------------------------------------ */

export const TableCreateSchema = z.object({
  config: TableConfigSchema.optional(),
});
export type TableCreatePayload = z.infer<typeof TableCreateSchema>;

export const TableJoinSchema = z.object({ code: TableCodeSchema });
export type TableJoinPayload = z.infer<typeof TableJoinSchema>;

export const TableSitSchema = z.object({
  seatIndex: z.number().int().min(0).max(8),
  buyIn: z.number().int().positive(),
});
export type TableSitPayload = z.infer<typeof TableSitSchema>;

/** "Deal me out", and "deal me back in". Takes effect from the next hand. */
export const PlayerSitOutSchema = z.object({ sittingOut: z.boolean() });
export type PlayerSitOutPayload = z.infer<typeof PlayerSitOutSchema>;

/** More chips, between hands only. The server checks it against the table's caps. */
export const PlayerRebuySchema = z.object({ amount: z.number().int().positive() });
export type PlayerRebuyPayload = z.infer<typeof PlayerRebuySchema>;

/**
 * "Show it anyway." A player whose hand was mucked at the showdown may turn it
 * over afterwards; nobody else can ask on their behalf, and the request only
 * stands for the hand it was made in.
 */
export const PlayerShowSchema = z.object({ handId: z.uuid() });
export type PlayerShowPayload = z.infer<typeof PlayerShowSchema>;

/** The host stopping or restarting the deal. The hand in progress always finishes. */
export const TablePauseSchema = z.object({ paused: z.boolean() });
export type TablePausePayload = z.infer<typeof TablePauseSchema>;

export const PlayerActionTypeSchema = z.enum(['FOLD', 'CHECK', 'CALL', 'BET', 'RAISE', 'ALL_IN']);
export type PlayerActionType = z.infer<typeof PlayerActionTypeSchema>;

export const PlayerActionSchema = z.object({
  /** Which hand this action belongs to; a stale one is refused, not applied. */
  handId: z.uuid(),
  /** How many actions the client believes have been taken this hand. */
  actionSeq: z.number().int().nonnegative(),
  type: PlayerActionTypeSchema,
  /** The total this seat will have committed on this street. Never clamped. */
  amount: z.number().int().nonnegative().optional(),
});
export type PlayerActionPayload = z.infer<typeof PlayerActionSchema>;

export const ChatSendSchema = z.object({ text: z.string().trim().min(1).max(280) });
export type ChatSendPayload = z.infer<typeof ChatSendSchema>;

export const StateResyncSchema = z.object({ fromVersion: z.number().int().nonnegative() });
export type StateResyncPayload = z.infer<typeof StateResyncSchema>;

/* ------------------------------------------------------------------ *
 * Server -> client                                                    *
 * ------------------------------------------------------------------ */

export interface StateSyncPayload {
  readonly version: number;
  readonly state: PublicTableState;
}

/** One engine event, as broadcast. Never carries a card that is not public. */
export interface TableEvent {
  readonly type: string;
  readonly [key: string]: unknown;
}

export interface StatePatchPayload {
  readonly version: number;
  readonly events: readonly TableEvent[];
  /**
   * The live board as it stands after these events.
   *
   * It rides on the patch rather than waiting for the next whole state because
   * a stack moves on nearly every event, and a board that only refreshed on a
   * resync would spend most of a hand showing the stacks from the last street.
   * It is not pieced together from the events by the client — the server states
   * it, through the same function `state:sync` uses.
   *
   * Optional only for the sake of a patch that has no server behind it: the
   * recorded hand the interface is reviewed against is a fixture, and a
   * recording has no live table to read a board off. A real server always sends
   * one. A client that receives a patch without it keeps the board it has and
   * moves the stacks it can see moving — see `applyPatch` on the web side.
   */
  readonly leaderboard?: readonly LiveLeaderboardRow[];
}

export interface HandDealtPayload {
  readonly handId: string;
  readonly seatIndex: number;
  readonly yourCards: readonly Card[];
}

export interface ActionPromptPayload {
  readonly handId: string;
  readonly seatIndex: number;
  readonly actionSeq: number;
  readonly legalActions: LegalActions;
  readonly deadlineTs: number;
}

export interface HandResultPayload {
  readonly handId: string;
  readonly pots: readonly Pot[];
  readonly awards: readonly { seatIndex: number; amount: number; potIndex: number }[];
  /** In showdown order: the last aggressor first, then clockwise. */
  readonly revealed: readonly {
    seatIndex: number;
    cards: readonly Card[];
    handName: string;
    order: number;
  }[];
  /** Reached the showdown and did not have to show. No cards, by construction. */
  readonly mucked: readonly { seatIndex: number; order: number }[];
}

export interface TableErrorPayload {
  readonly code: string;
  readonly message: string;
}

export interface ChatMessagePayload {
  readonly userId: string;
  readonly displayName: string;
  readonly text: string;
  readonly at: number;
}

export interface SessionReplacedPayload {
  readonly message: string;
}

/** Every server -> client event name, in one place. */
export const SERVER_EVENTS = {
  stateSync: 'state:sync',
  statePatch: 'state:patch',
  handDealt: 'hand:dealt',
  actionPrompt: 'action:prompt',
  handResult: 'hand:result',
  tableError: 'table:error',
  chatMessage: 'chat:message',
  sessionReplaced: 'session:replaced',
  /** The seed behind the hand that has just finished. */
  deckRevealed: 'deck:revealed',
} as const;

/** Every client -> server event name, in one place. */
export const CLIENT_EVENTS = {
  tableCreate: 'table:create',
  tableJoin: 'table:join',
  tableSit: 'table:sit',
  tableLeave: 'table:leave',
  tablePause: 'table:pause',
  playerAction: 'player:action',
  playerReady: 'player:ready',
  playerSitOut: 'player:sitout',
  playerRebuy: 'player:rebuy',
  playerShow: 'player:show',
  chatSend: 'chat:send',
  stateResync: 'state:resync',
} as const;
