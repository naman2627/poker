import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createDeck, createSeedRng, planDeal, shuffle } from '@poker/engine';
import type { HandVerification } from '@poker/shared';
import { cardCodes, type CardCode } from './records';
import { shownSeats, type StoredHand } from './sink';

/**
 * Provable fairness, both halves of it.
 *
 * Before a hand: draw 32 bytes, publish `sha256` of them, deal from them. After
 * a hand: publish the bytes. Anybody can then check two things, and both have to
 * hold:
 *
 *   the seed hashes to the commitment that was published *before* the deal, so
 *   the server cannot have chosen the seed after seeing how the hand went
 *
 *   the deck that seed produces, dealt out again, is the deal that actually
 *   happened, so the server cannot have committed to one deck and dealt another
 *
 * Either check alone proves nothing. A matching commitment with an unrelated
 * deal is a server that committed and then ignored it; a matching deal with a
 * commitment nobody published in advance is a server marking its own homework.
 */
export const DECK_SEED_BYTES = 32;

export function newDeckSeed(): string {
  return randomBytes(DECK_SEED_BYTES).toString('hex');
}

export function commitTo(seedHex: string): string {
  return createHash('sha256').update(Buffer.from(seedHex, 'hex')).digest('hex');
}

/** Constant-time, because comparing hashes is exactly where that habit belongs. */
export function commitmentHolds(seedHex: string, commit: string): boolean {
  const expected = Buffer.from(commitTo(seedHex), 'hex');
  const actual = Buffer.from(commit, 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/**
 * Re-run a recorded hand's deal and report what was found.
 *
 * Deliberately does not throw for a hand that cannot be verified — "this hand is
 * still in progress" and "this hand does not check out" are both answers a
 * client should be able to render, and only one of them is alarming.
 *
 * `viewerUserId` changes what is *shown*, never what is *checked*. Every seat's
 * cards are compared, including the ones that mucked; a mucked seat comes back
 * with `recorded: null` and `matches` still computed. That is what lets somebody
 * be sure the deal was straight without learning a hand its owner declined to
 * show.
 */
export function verifyHand(hand: StoredHand, viewerUserId: string | null): HandVerification {
  const empty = {
    handId: hand.id,
    deckCommit: hand.deckCommit,
    deckSeed: hand.deckSeed,
    deck: [],
    seats: [],
    board: { computed: [], recorded: [...hand.board], matches: false },
  };

  if (hand.deckSeed === null || hand.endedAt === null) {
    return {
      ...empty,
      verified: false,
      commitmentMatches: false,
      dealMatches: false,
      reason: 'this hand is still in progress — the seed is published when it ends, and not before',
    };
  }

  const commitmentMatches = commitmentHolds(hand.deckSeed, hand.deckCommit);

  // The deck the published seed produces. Same shuffle, same deal order, same
  // functions the table used — `createSeedRng` and `planDeal` are shared with
  // the engine precisely so this cannot drift away from what really happened.
  const deck = shuffle(createDeck(), createSeedRng(hand.deckSeed));
  const dealt = planDeal({
    deck,
    seatCount: seatCountOf(hand),
    buttonSeat: hand.buttonSeat,
    dealtInSeats: hand.players.map((player) => player.seatIndex),
    boardSize: hand.board.length,
  });

  const shown = shownSeats(hand);
  const computedBoard = cardCodes(dealt.board);
  const boardMatches = sameCards(computedBoard, hand.board);

  const seats = dealt.holeCards.map((computed) => {
    const player = hand.players.find((candidate) => candidate.seatIndex === computed.seatIndex);
    const computedCodes = cardCodes(computed.cards);
    const recorded = player?.holeCards ?? null;

    const maySee =
      player !== undefined && (player.userId === viewerUserId || shown.has(player.seatIndex));

    return {
      seatIndex: computed.seatIndex,
      displayName: player?.displayName ?? `Seat ${String(computed.seatIndex + 1)}`,
      computed: maySee ? computedCodes : [],
      recorded: maySee && recorded !== null ? [...recorded] : null,
      // Checked against the real record either way. Hiding a card from a reader
      // is not the same as declining to check it.
      matches: recorded !== null && sameCards(computedCodes, recorded),
    };
  });

  const dealMatches = boardMatches && seats.every((seat) => seat.matches);

  return {
    handId: hand.id,
    verified: commitmentMatches && dealMatches,
    deckCommit: hand.deckCommit,
    deckSeed: hand.deckSeed,
    commitmentMatches,
    dealMatches,
    reason: null,
    deck: deck.map((card) => ({ rank: card.rank, suit: card.suit })),
    seats,
    board: { computed: computedBoard, recorded: [...hand.board], matches: boardMatches },
  };
}

function sameCards(a: readonly CardCode[], b: readonly CardCode[]): boolean {
  return a.length === b.length && a.every((card, index) => card === b[index]);
}

/**
 * How wide the table was.
 *
 * Not stored on the hand, and it does not need to be. `dealOrder` produces the
 * dealt-in seats sorted by `(seat - button - 1) mod seatCount` — the cyclic
 * order starting to the button's left. That permutation is the same for any
 * modulus large enough to hold every seat involved, because widening the table
 * only inserts empty seats the deal skips. So the smallest such modulus gives
 * the right order, and this is it.
 */
function seatCountOf(hand: StoredHand): number {
  const highest = hand.players.reduce((max, player) => Math.max(max, player.seatIndex), 0);
  return Math.max(highest + 1, hand.buttonSeat + 1);
}
