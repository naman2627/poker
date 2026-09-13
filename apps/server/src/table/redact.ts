import type { Card, Seat, TableState } from '@poker/engine';
import type { LiveLeaderboardRow, PublicSeat, PublicTableState } from '@poker/shared';

/**
 * THE ONE RULE (CLAUDE.md §1).
 *
 * This is the only function in the codebase that turns a `TableState` into
 * something a client may see, and `broadcast.ts` is the only file that sends
 * what it returns. Nothing else may hand-build a payload out of table state —
 * if you find yourself wanting to, route it through here instead.
 *
 * What never leaves:
 *   - the deck, whose order is the rest of the hand; clients get a count
 *   - every seat's hole cards, except the viewer's own and the ones the server
 *     has decided are face up
 *
 * That last point is a set, not a rule re-derived here: `revealedSeats` is
 * exactly the seats the engine turned over at the showdown, plus anyone who
 * later chose to show a hand they had mucked. A hand that mucked is not in it,
 * so its cards do not leave — which is the whole point of mucking, and would be
 * quietly undone by any "everyone still in is public at showdown" shortcut.
 *
 * There is no rng state or deck seed in `TableState` to strip: the engine takes
 * its randomness as an argument, and the `Rng` lives on the runtime, which is
 * never serialised.
 */
export interface MemberProfile {
  readonly displayName: string;
  readonly avatarSeed: string | null;
}

/**
 * What one player has done since they sat down.
 *
 * Held by the runtime, never written anywhere, and cleared when they stand up.
 * `boughtIn` is the buy-in plus every rebuy, which is what makes `net` on the
 * live board mean "up or down for this sitting" rather than "up or down against
 * whatever number you happen to be looking at".
 */
export interface LiveSession {
  readonly boughtIn: number;
  readonly handsWon: number;
  readonly biggestPot: number;
}

/**
 * Decoration the table knows and the engine does not. None of it can affect
 * which cards are visible — that is decided from the state alone, below.
 */
export interface RedactionContext {
  readonly tableCode?: string;
  readonly members?: ReadonlyMap<string, MemberProfile>;
  /** Per-sitting counters for the live board. See `liveLeaderboard`. */
  readonly sessions?: ReadonlyMap<string, LiveSession>;
  readonly actionDeadlineTs?: number | null;
  /** Seats whose cards the server has turned face up. Nothing else is public. */
  readonly revealedSeats?: ReadonlySet<number>;
  /** Seats that reached a showdown and mucked, so a client can offer them Show. */
  readonly muckedSeats?: ReadonlySet<number>;
  readonly hostUserId?: string | null;
  readonly paused?: boolean;
  /** sha256 of this hand's deck seed, published before the cards come out. */
  readonly deckCommit?: string | null;
}

export function redactFor(
  state: TableState,
  viewerUserId: string | null,
  context: RedactionContext = {},
): PublicTableState {
  const revealed = context.revealedSeats ?? EMPTY;

  /**
   * SPECTATORS.
   *
   * Somebody watching a table is not sitting at it, so there is no seat whose
   * cards are "theirs" — and this is where that becomes structural rather than
   * incidental. A viewer with no seat is reduced to `null` here, once, before
   * anything downstream asks whether a seat belongs to them.
   *
   * It would already behave correctly without this line: `isViewer` compares
   * against `seat.playerId`, and a spectator matches no seat. But "no card is
   * the viewer's because no seat is theirs" is an accident of a comparison,
   * while "the viewer is nobody" is a property of the input. The second one
   * survives somebody adding a different reason to show a card.
   *
   * There is no second serialisation path for a spectator, and there must never
   * be one: a watcher sees exactly what `redactFor` returns for a null viewer,
   * which is the public table — the board, the pots, and only the hands the
   * showdown actually turned over. A seat that mucked stays mucked for them too.
   */
  const seated = seatIndexOf(state, viewerUserId) !== null;
  const viewer = seated ? viewerUserId : null;

  return {
    tableCode: context.tableCode ?? '',
    handId: state.handId,
    handNumber: state.handNumber,
    phase: state.phase,
    buttonSeat: state.buttonSeat,
    sbSeat: state.sbSeat,
    bbSeat: state.bbSeat,
    smallBlind: state.smallBlind,
    bigBlind: state.bigBlind,
    board: state.board.map(copyCard),
    seats: state.seats.map((seat) =>
      seat === null ? null : toPublicSeat(seat, viewer, revealed, state, context),
    ),
    currentBet: state.currentBet,
    minRaise: state.minRaise,
    lastAggressorSeat: state.lastAggressorSeat,
    toActSeat: state.toActSeat,
    pots: state.pots.map((pot) => ({ amount: pot.amount, eligibleSeats: [...pot.eligibleSeats] })),
    // The count, never the cards.
    deckRemaining: state.deck.length,
    actionDeadlineTs: context.actionDeadlineTs ?? null,
    viewerSeatIndex: seatIndexOf(state, viewer),
    hostUserId: context.hostUserId ?? null,
    paused: context.paused ?? false,
    deckCommit: context.deckCommit ?? null,
    muckedSeats: [...(context.muckedSeats ?? EMPTY)].sort((a, b) => a - b),
    leaderboard: liveLeaderboard(state, context),
  };
}

/**
 * The LIVE board.
 *
 * Derived from the seats and the runtime's own per-sitting counters, computed
 * fresh every time the table publishes anything, and stored nowhere. That is the
 * whole design: there is no leaderboard state to keep in step with the table,
 * because the leaderboard *is* the table, read a different way.
 *
 * It lives in this file rather than beside the runtime for the reason at the top
 * of it — this is the one place table state is turned into something a client
 * may see (CLAUDE.md §1), and a board is table state. `redactFor` calls it for a
 * whole sync and `broadcast.ts` calls it for a patch, so both go through here
 * and neither hand-builds a payload.
 *
 * There is nothing to redact in the result — no cards, and no number a seated
 * player could not already work out by watching the felt — but it is built here
 * anyway, so that stays true by construction rather than by anyone remembering.
 *
 * Sorted by stack, biggest first, with the seat index breaking a tie so two
 * players sitting behind the same amount do not swap places on every patch.
 */
export function liveLeaderboard(
  state: TableState,
  context: RedactionContext = {},
): LiveLeaderboardRow[] {
  const rows: LiveLeaderboardRow[] = [];

  for (const seat of state.seats) {
    if (seat === null) continue;

    const profile = context.members?.get(seat.playerId);
    const session = context.sessions?.get(seat.playerId);

    rows.push({
      seatIndex: seat.seatIndex,
      userId: seat.playerId,
      displayName: profile?.displayName ?? '',
      avatarSeed: profile?.avatarSeed ?? null,
      stack: seat.stack,
      // Signed, and the only number here that can be negative. A player who has
      // bought in twice for 200 and is sitting behind 150 is at -250.
      net: seat.stack - (session?.boughtIn ?? seat.stack),
      handsWon: session?.handsWon ?? 0,
      biggestPot: session?.biggestPot ?? 0,
    });
  }

  return rows.sort((a, b) => (b.stack === a.stack ? a.seatIndex - b.seatIndex : b.stack - a.stack));
}

const EMPTY: ReadonlySet<number> = new Set();

/** The seat a user is sitting in, or null when they are only watching. */
export function seatIndexOf(state: TableState, userId: string | null): number | null {
  if (userId === null) return null;
  const seat = state.seats.find((candidate) => candidate?.playerId === userId);
  return seat ? seat.seatIndex : null;
}

function toPublicSeat(
  seat: Seat,
  viewerUserId: string | null,
  revealed: ReadonlySet<number>,
  state: TableState,
  context: RedactionContext,
): PublicSeat {
  const isViewer = viewerUserId !== null && seat.playerId === viewerUserId;
  const profile = context.members?.get(seat.playerId);

  return {
    seatIndex: seat.seatIndex,
    userId: seat.playerId,
    displayName: profile?.displayName ?? '',
    avatarSeed: profile?.avatarSeed ?? null,
    stack: seat.stack,
    status: seat.status,
    committedThisRound: seat.committedThisRound,
    committedThisHand: seat.committedThisHand,
    hasActedThisRound: seat.hasActedThisRound,
    cardCount: seat.holeCards.length,
    holeCards: isViewer || revealed.has(seat.seatIndex) ? seat.holeCards.map(copyCard) : null,
    sittingOut: seat.sittingOut,
    leaving: state.pendingLeave.includes(seat.seatIndex),
    // "Will be dealt the next hand": the flag the player set, and the chips to
    // play it with.
    isReady: !seat.sittingOut && seat.stack > 0,
  };
}

function copyCard(card: Card): { rank: number; suit: Card['suit'] } {
  return { rank: card.rank, suit: card.suit };
}
