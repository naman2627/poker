import { z } from 'zod';
import { CardSchema } from './table';

/**
 * The record of play, as clients read it back.
 *
 * Two things live here: the fairness commitment for a hand, and the history a
 * table can be replayed from. Both are read-only from a client's point of view —
 * nothing in this file is ever sent *to* the server.
 */

/**
 * A card as it is stored and replayed: rank then suit, `Ks`, `10h`, `Ad`.
 *
 * Short codes rather than objects because these go into a Postgres `text[]` and
 * come back out again, and a column somebody may well read by hand should be
 * legible when they do.
 */
export const CardCodeSchema = z.string().regex(/^(?:[2-9]|10|11|12|13|14)[shdc]$/);

/**
 * What the table publishes before the cards come out, and what it publishes
 * afterwards.
 *
 * `commit` is `sha256(seed)`. It goes out before the deal; the seed goes out
 * when the hand is over. Between those two moments the table has bound itself to
 * a deck it cannot change, and nobody — the server included — can work out what
 * that deck is.
 */
export interface DeckRevealedPayload {
  readonly handId: string;
  readonly deckCommit: string;
  readonly deckSeed: string;
}

/* ------------------------------------------------------------------ *
 * Reading a hand back                                                 *
 * ------------------------------------------------------------------ */

export const HandActionSchema = z.object({
  seq: z.number().int().nonnegative(),
  userId: z.uuid().nullable(),
  seatIndex: z.number().int().nullable(),
  displayName: z.string(),
  street: z.enum(['preflop', 'flop', 'turn', 'river', 'showdown', 'payout']),
  /** `FOLD`, `CALL`, `DEAL`, `WIN`, `SHOW`… see `history/records.ts` on the server. */
  action: z.string(),
  amount: z.number().int().nonnegative(),
  potAfter: z.number().int().nonnegative(),
  /** Milliseconds from the start of the hand, so a replay can keep its timing. */
  elapsedMs: z.number().int().nonnegative(),
  /** The board as it stood after this step. Never a hole card. */
  board: z.array(CardCodeSchema),
});
export type HandActionEntry = z.infer<typeof HandActionSchema>;

export const HandPlayerSchema = z.object({
  userId: z.uuid(),
  seatIndex: z.number().int().nonnegative(),
  displayName: z.string(),
  /**
   * Null when the reader is not entitled to them: a hand still in progress, or
   * somebody else's cards that were mucked rather than shown.
   */
  holeCards: z.array(CardCodeSchema).nullable(),
  startingStack: z.number().int().nonnegative(),
  endingStack: z.number().int().nonnegative().nullable(),
  net: z.number().int().nullable(),
  wentToShowdown: z.boolean(),
  won: z.boolean(),
});
export type HandPlayerEntry = z.infer<typeof HandPlayerSchema>;

export const HandSummarySchema = z.object({
  id: z.uuid(),
  handNumber: z.number().int().positive(),
  buttonSeat: z.number().int().nonnegative(),
  smallBlind: z.number().int().positive(),
  bigBlind: z.number().int().positive(),
  board: z.array(CardCodeSchema),
  totalPot: z.number().int().nonnegative(),
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime().nullable(),
  deckCommit: z.string(),
  /** Present only once the hand is over. */
  deckSeed: z.string().nullable(),
  winners: z.array(
    z.object({
      userId: z.uuid(),
      seatIndex: z.number().int().nonnegative(),
      displayName: z.string(),
      net: z.number().int(),
    }),
  ),
});
export type HandSummary = z.infer<typeof HandSummarySchema>;

export const HandDetailSchema = HandSummarySchema.extend({
  players: z.array(HandPlayerSchema),
  actions: z.array(HandActionSchema),
});
export type HandDetail = z.infer<typeof HandDetailSchema>;

/**
 * `pending` and `paused` are the honest bit: history is written off the critical
 * path, so a database that is unwell means the list is behind, not that the
 * table stopped. Saying so beats showing a short list as if it were complete.
 */
export const HandHistoryResponseSchema = z.object({
  tableCode: z.string(),
  hands: z.array(HandSummarySchema),
  statsPaused: z.boolean(),
  pendingWrites: z.number().int().nonnegative(),
});
export type HandHistoryResponse = z.infer<typeof HandHistoryResponseSchema>;

/* ------------------------------------------------------------------ *
 * Proving the deal                                                    *
 * ------------------------------------------------------------------ */

/**
 * The answer to "was that deal straight?", with enough in it to check by hand.
 *
 * `commitmentMatches` is sha256 of the published seed against the commitment
 * published before the deal. `dealMatches` is the deck that seed produces,
 * dealt out again, against the cards that were actually recorded. Both have to
 * be true; either one alone proves nothing.
 */
export const HandVerificationSchema = z.object({
  handId: z.uuid(),
  verified: z.boolean(),
  deckCommit: z.string(),
  deckSeed: z.string().nullable(),
  commitmentMatches: z.boolean(),
  dealMatches: z.boolean(),
  /** Why it could not be checked, when it could not be. */
  reason: z.string().nullable(),
  /** The full 52-card deck the seed produces, top first. */
  deck: z.array(CardSchema),
  /** What that deck deals, next to what the hand actually recorded. */
  seats: z.array(
    z.object({
      seatIndex: z.number().int().nonnegative(),
      displayName: z.string(),
      computed: z.array(CardCodeSchema),
      recorded: z.array(CardCodeSchema).nullable(),
      matches: z.boolean(),
    }),
  ),
  board: z.object({
    computed: z.array(CardCodeSchema),
    recorded: z.array(CardCodeSchema),
    matches: z.boolean(),
  }),
});
export type HandVerification = z.infer<typeof HandVerificationSchema>;
