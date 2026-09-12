/**
 * What the table hands to the recorder.
 *
 * These are plain values, not database rows: the runtime builds them and drops
 * them in a queue, and it never learns whether the write worked. That is the
 * whole point — a hand must not be able to fail because a disk did.
 *
 * A card here is a short code (`Ks`, `10h`) rather than an object, so the thing
 * that lands in a `text[]` is the thing you would want to read if you ever
 * opened the column by hand.
 */
import type { Card, HandCategory } from '@poker/engine';

export type CardCode = string;

export function cardCode(card: Card): CardCode {
  return `${String(card.rank)}${card.suit}`;
}

export function cardCodes(cards: readonly Card[]): CardCode[] {
  return cards.map(cardCode);
}

/** The streets an action can happen on, as recorded. */
export type Street = 'preflop' | 'flop' | 'turn' | 'river' | 'showdown' | 'payout';

export interface TableOpened {
  readonly kind: 'table-opened';
  readonly code: string;
  readonly hostUserId: string | null;
  readonly config: unknown;
  readonly at: Date;
}

export interface TableClosed {
  readonly kind: 'table-closed';
  readonly code: string;
  readonly at: Date;
}

export interface SessionStarted {
  readonly kind: 'session-started';
  readonly code: string;
  readonly userId: string;
  readonly displayName: string;
  readonly seatIndex: number;
  readonly buyIn: number;
  readonly at: Date;
}

export interface SessionEnded {
  readonly kind: 'session-ended';
  readonly code: string;
  readonly userId: string;
  readonly cashOut: number;
  readonly at: Date;
}

export interface HandStarted {
  readonly kind: 'hand-started';
  readonly code: string;
  readonly handId: string;
  readonly handNumber: number;
  readonly buttonSeat: number;
  readonly smallBlind: number;
  readonly bigBlind: number;
  /** sha256 of the seed. The seed itself is not in this record, on purpose. */
  readonly deckCommit: string;
  readonly at: Date;
  readonly players: readonly {
    readonly userId: string;
    /**
     * Carried for the benefit of a sink with no `users` table to join —
     * the in-memory one. Postgres ignores it: a name belongs on the account,
     * and copying it into every hand would be a second source of truth that
     * went stale the first time somebody renamed themselves.
     */
    readonly displayName: string;
    readonly seatIndex: number;
    readonly startingStack: number;
  }[];
}

export interface HandAction {
  readonly kind: 'hand-action';
  readonly handId: string;
  readonly seq: number;
  readonly userId: string | null;
  readonly street: Street;
  readonly action: string;
  readonly amount: number;
  readonly potAfter: number;
  readonly elapsedMs: number;
}

/**
 * The end of a hand, and the only record that carries anybody's cards.
 *
 * The sink is required to write all of this in one transaction, so the moment
 * hole cards appear in the database is the same moment the hand is marked over.
 *
 * Every dealt hand is recorded, including the ones that mucked. An audit trail
 * that skipped them could not prove the deal was straight — the seat nobody saw
 * is exactly the seat a crooked deal would hide in. What mucking controls is who
 * may *read* those cards back, which is the read layer's job: your own always,
 * anybody else's only if they showed. See `redactHand` in `sink.ts`.
 */
export interface HandEnded {
  readonly kind: 'hand-ended';
  readonly handId: string;
  readonly board: readonly CardCode[];
  readonly totalPot: number;
  readonly deckSeed: string;
  /** The blind this hand was played for, which is what BB/100 is measured in. */
  readonly bigBlind: number;
  readonly at: Date;
  readonly players: readonly {
    /**
     * Whose seat this was. The history sink finds it by joining on the hand;
     * the statistics cannot, because a counter belongs to an account rather
     * than to a chair, and the account is the whole key.
     */
    readonly userId: string;
    readonly seatIndex: number;
    /** The two cards this seat was dealt, shown or not. */
    readonly holeCards: readonly CardCode[];
    /** Whether the table saw them. Decides who may read them back later. */
    readonly shown: boolean;
    readonly endingStack: number;
    readonly net: number;
    /** Everything this seat put in this hand — blinds, calls, bets and raises. */
    readonly wagered: number;
    /** Chips taken out of the middle. Zero for everybody who did not win one. */
    readonly potWon: number;
    /**
     * The made hand, but only if the table actually saw it.
     *
     * Null for a hand that mucked, and null for one that never reached a
     * showdown. A mucked hand is its owner's (CLAUDE.md §1), and counting its
     * category into a public "best hand" statistic would be publishing it a
     * chip at a time.
     */
    readonly shownCategory: HandCategory | null;
    readonly wentToShowdown: boolean;
    readonly won: boolean;
  }[];
}

export type HistoryRecord =
  TableOpened | TableClosed | SessionStarted | SessionEnded | HandStarted | HandAction | HandEnded;
