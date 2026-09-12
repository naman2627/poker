import type { HandDetail, HandPlayerEntry, HandSummary } from '@poker/shared';
import type { CardCode, HistoryRecord, Street } from './records';

/**
 * Where the record of play goes.
 *
 * One interface, two implementations: Postgres, and a set of Maps for running
 * without a database. Everything above this line — the queue, the routes, the
 * fairness check — is written against the interface, so "history works, there is
 * just nowhere to put it" is a configuration rather than a special case.
 *
 * Every method may reject. That is the recorder's problem, not the table's.
 */
export interface HistorySink {
  /**
   * Apply one record.
   *
   * `hand-ended` MUST be atomic: hole cards and `ended_at` land together or not
   * at all. A dump taken while a hand is in progress must not contain anybody's
   * cards, and a half-applied ending would put them there.
   */
  write(record: HistoryRecord): Promise<void>;
  /** Most recent first. */
  recentHands(tableCode: string, limit: number): Promise<StoredHand[]>;
  hand(handId: string): Promise<StoredHand | null>;
  close(): Promise<void>;
}

/** A hand as it comes back out, before anything is hidden from anybody. */
export interface StoredHand {
  readonly id: string;
  readonly tableCode: string;
  readonly handNumber: number;
  readonly buttonSeat: number;
  readonly smallBlind: number;
  readonly bigBlind: number;
  readonly board: readonly CardCode[];
  readonly totalPot: number;
  readonly deckSeed: string | null;
  readonly deckCommit: string;
  readonly startedAt: Date;
  readonly endedAt: Date | null;
  readonly players: readonly StoredHandPlayer[];
  readonly actions: readonly StoredHandAction[];
}

export interface StoredHandPlayer {
  readonly userId: string;
  readonly seatIndex: number;
  readonly displayName: string;
  /** Null while the hand is live. Otherwise every seat's real cards. */
  readonly holeCards: readonly CardCode[] | null;
  readonly startingStack: number;
  readonly endingStack: number | null;
  readonly net: number | null;
  readonly wentToShowdown: boolean;
  readonly won: boolean;
}

export interface StoredHandAction {
  readonly seq: number;
  readonly userId: string | null;
  readonly seatIndex: number | null;
  readonly displayName: string;
  readonly street: Street;
  readonly action: string;
  readonly amount: number;
  readonly potAfter: number;
  readonly elapsedMs: number;
}

/**
 * Which seats turned their cards over.
 *
 * Derived from the actions rather than stored twice: a `SHOW` is recorded when a
 * hand goes face up, so the actions already know. Anything not in here mucked,
 * and mucked cards stay the owner's.
 */
export function shownSeats(hand: StoredHand): Set<number> {
  const shown = new Set<number>();
  for (const action of hand.actions) {
    if (action.action === 'SHOW' && action.seatIndex !== null) shown.add(action.seatIndex);
  }
  return shown;
}

/**
 * A hand as one particular person may read it.
 *
 * The same rule the felt uses, applied to the record: your own cards always,
 * somebody else's only if they showed them. A hand that mucked is not in the
 * history either, however long ago it was played — mucking is not a delay on
 * publication, it is a refusal to publish.
 */
export function redactHand(hand: StoredHand, viewerUserId: string | null): HandDetail {
  const shown = shownSeats(hand);

  const players: HandPlayerEntry[] = hand.players.map((player) => ({
    userId: player.userId,
    seatIndex: player.seatIndex,
    displayName: player.displayName,
    holeCards:
      player.holeCards !== null && (player.userId === viewerUserId || shown.has(player.seatIndex))
        ? [...player.holeCards]
        : null,
    startingStack: player.startingStack,
    endingStack: player.endingStack,
    net: player.net,
    wentToShowdown: player.wentToShowdown,
    won: player.won,
  }));

  return {
    ...summarise(hand),
    players,
    actions: withBoard(hand),
  };
}

export function summarise(hand: StoredHand): HandSummary {
  return {
    id: hand.id,
    handNumber: hand.handNumber,
    buttonSeat: hand.buttonSeat,
    smallBlind: hand.smallBlind,
    bigBlind: hand.bigBlind,
    board: [...hand.board],
    totalPot: hand.totalPot,
    startedAt: hand.startedAt.toISOString(),
    endedAt: hand.endedAt === null ? null : hand.endedAt.toISOString(),
    deckCommit: hand.deckCommit,
    deckSeed: hand.deckSeed,
    winners: hand.players
      .filter((player) => player.won)
      .map((player) => ({
        userId: player.userId,
        seatIndex: player.seatIndex,
        displayName: player.displayName,
        net: player.net ?? 0,
      })),
  };
}

/**
 * The board as it stood after each step.
 *
 * Rebuilt from the `DEAL` actions rather than stored on every row: the hand
 * knows its five cards and the actions know when each street came out, so a
 * replay can show the felt at any point without a column repeating itself
 * twenty times a hand.
 */
function withBoard(hand: StoredHand): HandDetail['actions'] {
  const sizes: Readonly<Record<string, number>> = { flop: 3, turn: 4, river: 5 };
  let shown = 0;

  return hand.actions.map((action) => {
    if (action.action === 'DEAL') shown = sizes[action.street] ?? shown;
    return {
      seq: action.seq,
      userId: action.userId,
      seatIndex: action.seatIndex,
      displayName: action.displayName,
      street: action.street,
      action: action.action,
      amount: action.amount,
      potAfter: action.potAfter,
      elapsedMs: action.elapsedMs,
      board: hand.board.slice(0, shown),
    };
  });
}
