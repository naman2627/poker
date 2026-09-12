import type { LeaderboardMetric, PlayerHand, PlayerStatCard } from '@poker/shared';
import type { PlayerHandDelta, StatCounters } from './delta';

/**
 * The two halves of the statistics layer, as interfaces.
 *
 * `StatsStore` is the truth: counters in Postgres, written in the transaction
 * that ends a hand. `LeaderboardIndex` is a mirror of that truth in sorted sets,
 * kept for one reason — a top fifty and "what is my rank" in one round trip
 * instead of an order-by across every account.
 *
 * The asymmetry between them is the whole design and is worth stating plainly:
 *
 *   - a write that reaches Postgres and not Redis leaves the board stale until
 *     the next rebuild, and loses nothing
 *   - a write that reached Redis and not Postgres would be a number nobody
 *     could ever reproduce, so that ordering is not allowed to happen: the
 *     transaction commits first, and only then is the mirror touched
 *   - Redis being empty, evicted or entirely absent is a supported state, and
 *     `rebuildLeaderboards()` is what makes it one
 *
 * Two implementations of each: Postgres and Redis for real, Maps for a laptop
 * with neither installed — the same arrangement `history/sink.ts` and
 * `auth/ports.ts` already use.
 */

/** A player's counters over one period, with the account they belong to. */
export interface StatsSnapshotRow {
  readonly userId: string;
  readonly counters: StatCounters;
}

/** A player, as a board needs to name them. */
export interface StatsProfile {
  readonly userId: string;
  readonly displayName: string;
  readonly avatarSeed: string | null;
}

export interface StatsStore {
  /**
   * Count one finished hand.
   *
   * Every delta and every period lands in one transaction, so a hand is counted
   * completely or not at all. It returns the rows as they now stand, which is
   * what the mirror is built from: the totals are read back from the write
   * rather than guessed at from the delta.
   */
  applyHand(deltas: readonly PlayerHandDelta[]): Promise<AppliedHand>;

  /** Every row for one period, for a rebuild. All-time is `'alltime'`. */
  snapshot(periodKey: string): Promise<StatsSnapshotRow[]>;

  /** Every period key that has rows, so a rebuild knows what to rebuild. */
  periodKeys(): Promise<string[]>;

  /** One player's counters for one period, or null if they have none. */
  counters(userId: string, periodKey: string): Promise<StatCounters | null>;

  /**
   * The same, for a page of the board, in one query.
   *
   * A top fifty needs fifty stat cards to fill its other columns, and fifty
   * round trips to get them would undo the point of having an index at all.
   */
  countersMany(userIds: readonly string[], periodKey: string): Promise<Map<string, StatCounters>>;

  /** Names and avatars for a page of the board, in one query. */
  profiles(userIds: readonly string[]): Promise<Map<string, StatsProfile>>;

  /**
   * A board straight from Postgres, ordered and limited.
   *
   * The fallback for when Redis cannot be reached, and the thing a rebuild
   * reads. It is an index scan over one small table — never a scan of
   * `hand_actions`, which is a replay log and has no business being aggregated
   * on a request.
   */
  top(metric: LeaderboardMetric, periodKey: string, limit: number): Promise<StatsSnapshotRow[]>;

  /** One-based position, or null when the player does not qualify or has no row. */
  rank(userId: string, metric: LeaderboardMetric, periodKey: string): Promise<number | null>;

  /** The last `limit` hands this player finished, most recent first. */
  recentHands(userId: string, limit: number): Promise<PlayerHand[]>;

  close(): Promise<void>;
}

/** The rows one hand's transaction left behind, ready to mirror. */
export interface AppliedHand {
  readonly entries: readonly AppliedEntry[];
}

export interface AppliedEntry {
  readonly userId: string;
  readonly periodKey: string;
  /** What this hand moved the additive counters by. `ZINCRBY` takes these. */
  readonly delta: PlayerHandDelta;
  /** The row as it now stands. The maxima and the rates are set from these. */
  readonly counters: StatCounters;
}

export interface LeaderboardIndex {
  /**
   * Push one hand's worth of movement into the sorted sets.
   *
   * Best effort by construction: the truth is already committed, so a failure
   * here is a stale board and is logged rather than thrown. It never blocks the
   * table, and it never blocks the transaction that produced it.
   */
  mirror(applied: AppliedHand): Promise<void>;

  /** Replace one board wholesale. Used only by the rebuild, and atomically. */
  replace(
    metric: LeaderboardMetric,
    periodKey: string,
    entries: readonly { userId: string; score: number }[],
  ): Promise<void>;

  /** `ZREVRANGE key 0 limit-1 WITHSCORES`. */
  top(
    metric: LeaderboardMetric,
    periodKey: string,
    limit: number,
  ): Promise<{ userId: string; score: number }[]>;

  /** `ZREVRANK`, as a one-based position. Null when the member is not there. */
  rank(userId: string, metric: LeaderboardMetric, periodKey: string): Promise<number | null>;

  /** Whether the index can be reached at all. A false answer means "use Postgres". */
  healthy(): Promise<boolean>;

  close(): Promise<void>;
}

/** Converting counters into the card the wire carries. */
export function toStatCard(counters: StatCounters): PlayerStatCard {
  return {
    handsPlayed: counters.handsPlayed,
    handsWon: counters.handsWon,
    showdownsSeen: counters.showdownsSeen,
    showdownsWon: counters.showdownsWon,
    netChips: counters.netChips,
    biggestPot: counters.biggestPot,
    bestHandCategory: counters.bestHandCategory,
    bestHandAt: counters.bestHandAt === null ? null : counters.bestHandAt.toISOString(),
    totalWagered: counters.totalWagered,
    longestWinStreak: counters.longestWinStreak,
    currentWinStreak: counters.currentWinStreak,
    // The hand-weighted average blind these hands were played for. See
    // `bbPer100` in @poker/shared for why this is the divisor.
    bigBlind: counters.handsPlayed === 0 ? 0 : counters.bigBlindSum / counters.handsPlayed,
    updatedAt: counters.updatedAt.toISOString(),
  };
}
