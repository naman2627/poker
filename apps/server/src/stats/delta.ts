import { HAND_CATEGORIES } from '@poker/engine';
import { HAND_CATEGORY_ORDER, handCategoryRank, type HandCategory } from '@poker/shared';
import type { HandEnded } from '../history/records';
import { periodKeysFor, ALLTIME_KEY } from './periods';

/**
 * One finished hand, turned into counters.
 *
 * Pure, and deliberately so: it takes the record the table already produced and
 * returns what each player's row should move by. No clock, no database, no
 * Redis. Everything that decides what a leaderboard says is decided here and is
 * testable by calling a function.
 *
 * A hand produces one delta per seat that was dealt in, and each delta is
 * applied to three rows: all-time, the month, and the ISO week — the same hand
 * counted three times into three buckets, which is why `periodKeys` is on the
 * delta rather than worked out again further down.
 */

/**
 * The two definitions of a made hand's name — the engine's and the wire's —
 * checked against each other once, here, at module load.
 *
 * @poker/shared cannot import @poker/engine, so it keeps its own copy of the
 * category list. This file is the one place that can see both, so this is where
 * a drift between them becomes a startup failure rather than a leaderboard that
 * quietly stops recording straight flushes.
 */
const engineCategories: readonly string[] = HAND_CATEGORIES;
const wireCategories: readonly string[] = HAND_CATEGORY_ORDER;
if (
  engineCategories.length !== wireCategories.length ||
  engineCategories.some((category, index) => category !== wireCategories[index])
) {
  throw new Error(
    'HAND_CATEGORIES in @poker/engine and HAND_CATEGORY_ORDER in @poker/shared have diverged. ' +
      'They must list the same categories in the same order — the second is the wire copy of the first.',
  );
}

/**
 * What one hand does to one player's counters.
 *
 * Additive fields are deltas to add. `biggestPot` and `bestHand` are *candidates*
 * rather than deltas: the store keeps whichever is larger, because "the biggest
 * pot you ever won" does not accumulate.
 *
 * `won` is carried as a flag rather than folded into a streak delta, because a
 * streak is not additive either — it depends on the value already in the row,
 * which only the store can see.
 */
export interface PlayerHandDelta {
  readonly userId: string;
  /** `alltime`, plus the month and week this hand was played in. */
  readonly periodKeys: readonly string[];
  readonly at: Date;

  readonly handsPlayed: number;
  readonly handsWon: number;
  readonly showdownsSeen: number;
  readonly showdownsWon: number;
  /** Signed. This is the only counter that can move a player down the board. */
  readonly netChips: number;
  readonly totalWagered: number;
  /** The big blind this hand was played for, summed for the BB/100 average. */
  readonly bigBlindSum: number;

  /** Kept only if bigger than what is already there. */
  readonly potWon: number;
  /** Kept only if stronger than what is already there, and null unless shown. */
  readonly shownCategory: HandCategory | null;
  readonly won: boolean;
}

/**
 * Every seat's counters for one hand.
 *
 * `wentToShowdown` counts a hand that reached the showdown whether or not it
 * was turned over — a mucked showdown is still a showdown you were in, and that
 * is a fact about the betting rather than about anybody's cards. The category
 * is the one thing gated on actually having shown.
 */
export function deltasFor(record: HandEnded): PlayerHandDelta[] {
  const periodKeys = [ALLTIME_KEY, ...periodKeysFor(record.at)];

  return record.players.map((player) => ({
    userId: player.userId,
    periodKeys,
    at: record.at,

    handsPlayed: 1,
    handsWon: player.won ? 1 : 0,
    showdownsSeen: player.wentToShowdown ? 1 : 0,
    showdownsWon: player.wentToShowdown && player.won ? 1 : 0,
    netChips: player.net,
    totalWagered: Math.max(0, player.wagered),
    bigBlindSum: Math.max(0, record.bigBlind),

    potWon: Math.max(0, player.potWon),
    shownCategory: player.shown ? player.shownCategory : null,
    won: player.won,
  }));
}

/**
 * The counters themselves, as a row anywhere holds them.
 *
 * Shared by the Postgres store, the in-memory store and the rebuild job, so
 * "apply a delta to a row" is written once rather than three times with three
 * chances to disagree about what a streak is.
 */
export interface StatCounters {
  handsPlayed: number;
  handsWon: number;
  showdownsSeen: number;
  showdownsWon: number;
  netChips: number;
  biggestPot: number;
  bestHandCategory: HandCategory | null;
  bestHandAt: Date | null;
  totalWagered: number;
  longestWinStreak: number;
  currentWinStreak: number;
  bigBlindSum: number;
  updatedAt: Date;
}

export function emptyCounters(at: Date): StatCounters {
  return {
    handsPlayed: 0,
    handsWon: 0,
    showdownsSeen: 0,
    showdownsWon: 0,
    netChips: 0,
    biggestPot: 0,
    bestHandCategory: null,
    bestHandAt: null,
    totalWagered: 0,
    longestWinStreak: 0,
    currentWinStreak: 0,
    bigBlindSum: 0,
    updatedAt: at,
  };
}

/**
 * Fold one hand into one row.
 *
 * The three non-additive rules, spelled out because they are the ones that get
 * written differently in two places and then disagree:
 *
 *   - the biggest pot is a maximum, not a total
 *   - the best hand is a maximum by category strength, and a tie keeps the
 *     earlier one — the first time you made quads is the one worth the date
 *   - the current streak is hands won *in a row*: a loss sets it to zero, and
 *     the longest is the high-water mark of that
 */
export function applyDelta(counters: StatCounters, delta: PlayerHandDelta): StatCounters {
  const currentWinStreak = delta.won ? counters.currentWinStreak + 1 : 0;

  const better =
    delta.shownCategory !== null &&
    handCategoryRank(delta.shownCategory) > handCategoryRank(counters.bestHandCategory);

  return {
    handsPlayed: counters.handsPlayed + delta.handsPlayed,
    handsWon: counters.handsWon + delta.handsWon,
    showdownsSeen: counters.showdownsSeen + delta.showdownsSeen,
    showdownsWon: counters.showdownsWon + delta.showdownsWon,
    netChips: counters.netChips + delta.netChips,
    biggestPot: Math.max(counters.biggestPot, delta.potWon),
    bestHandCategory: better ? delta.shownCategory : counters.bestHandCategory,
    bestHandAt: better ? delta.at : counters.bestHandAt,
    totalWagered: counters.totalWagered + delta.totalWagered,
    longestWinStreak: Math.max(counters.longestWinStreak, currentWinStreak),
    currentWinStreak,
    bigBlindSum: counters.bigBlindSum + delta.bigBlindSum,
    updatedAt: delta.at,
  };
}
