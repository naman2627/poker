import { z } from 'zod';

/**
 * Statistics, as both sides of the wire agree to talk about them.
 *
 * Two quite different things live under this roof, and it is worth keeping them
 * apart in your head:
 *
 *   - the LIVE board (`table.ts`, `LiveLeaderboardRow`) — this table, this
 *     sitting, derived from a `TableRuntime`'s memory and never written down
 *   - the GLOBAL board (everything here) — every hand a player has ever
 *     finished, counted in Postgres and mirrored into Redis for speed
 *
 * The formulas below are here rather than on the server because the client has
 * to say the same thing the ranking said. A board that ranks on one definition
 * of BB/100 and prints another is worse than no board at all, so there is one
 * definition and both sides call it.
 *
 * None of this is a poker rule (CLAUDE.md §2) — no deck, no legality, no pot
 * maths. It is arithmetic over counters somebody else already decided.
 *
 * And, as everywhere: chips are a game counter with no value (CLAUDE.md §5).
 */

/* ------------------------------------------------------------------ *
 * What can be ranked, and over what stretch of time                   *
 * ------------------------------------------------------------------ */

export const LeaderboardMetricSchema = z.enum([
  'net',
  'hands',
  'winRate',
  'bb100',
  'biggestPot',
  'bestHand',
]);
export type LeaderboardMetric = z.infer<typeof LeaderboardMetricSchema>;

export const LeaderboardPeriodSchema = z.enum(['alltime', 'month', 'week']);
export type LeaderboardPeriod = z.infer<typeof LeaderboardPeriodSchema>;

/** How many rows a board hands back. Matches the ZSET read on the server. */
export const LEADERBOARD_PAGE_SIZE = 50;

/**
 * THE THRESHOLD.
 *
 * A rate metric is a ratio, and a ratio over three hands is noise wearing a
 * number's clothes: one player who won a single big pot in their first session
 * would sit at the top of BB/100 for ever, and nothing anybody did afterwards
 * would move them. So a rate is only *ranked* once there are two hundred hands
 * under it. Below that the player is not unranked-and-hidden — they are shown
 * their own progress towards qualifying, which is the honest version of the
 * same fact.
 *
 * Totals (net chips, hands played, biggest pot, best hand) have no threshold:
 * they are sums, not ratios, and a big number really does mean a big number.
 */
export const MIN_RANKED_HANDS = 200;

/** The metrics the threshold applies to. */
export const RATE_METRICS: readonly LeaderboardMetric[] = ['winRate', 'bb100'];

export function isRateMetric(metric: LeaderboardMetric): boolean {
  return RATE_METRICS.includes(metric);
}

/** How many more hands before this player can be ranked on a rate. Zero when ready. */
export function handsToQualify(handsPlayed: number): number {
  return Math.max(0, MIN_RANKED_HANDS - handsPlayed);
}

/** Whether this player may appear in a ranking of `metric` at all. */
export function qualifiesFor(metric: LeaderboardMetric, handsPlayed: number): boolean {
  return !isRateMetric(metric) || handsPlayed >= MIN_RANKED_HANDS;
}

/* ------------------------------------------------------------------ *
 * The formulas                                                        *
 * ------------------------------------------------------------------ */

/** Hands won as a percentage of hands played. */
export function winRatePercent(handsWon: number, handsPlayed: number): number {
  if (handsPlayed <= 0) return 0;
  return (handsWon / handsPlayed) * 100;
}

/**
 * Big blinds won per hundred hands.
 *
 *   BB/100 = net_chips / big_blind / hands_played * 100
 *
 * `bigBlind` is the blind those hands were actually played for. A player who has
 * only ever sat at one table has one; a player who has moved between stakes has
 * their hand-weighted average, which is what `PlayerStatCard.bigBlind` carries
 * (the server keeps a running sum of every hand's big blind and divides). For a
 * single-stake player the two are the same number, and the formula above is
 * unchanged either way.
 */
export function bbPer100(netChips: number, bigBlind: number, handsPlayed: number): number {
  if (handsPlayed <= 0 || bigBlind <= 0) return 0;
  return (netChips / bigBlind / handsPlayed) * 100;
}

/* ------------------------------------------------------------------ *
 * Made hands                                                          *
 * ------------------------------------------------------------------ */

/**
 * Weakest to strongest, and the index is the strength — the same order and the
 * same names as `HAND_CATEGORIES` in @poker/engine.
 *
 * Copied rather than imported, for the reason the card vocabulary in `table.ts`
 * is copied: @poker/shared cannot depend on @poker/engine (the arrow runs the
 * other way), so the wire keeps its own copy. `stats/delta.ts` on the server
 * sits across both and is where the two are checked against each other.
 */
export const HAND_CATEGORY_ORDER = [
  'HIGH_CARD',
  'PAIR',
  'TWO_PAIR',
  'TRIPS',
  'STRAIGHT',
  'FLUSH',
  'FULL_HOUSE',
  'QUADS',
  'STRAIGHT_FLUSH',
] as const;

export const HandCategorySchema = z.enum(HAND_CATEGORY_ORDER);
export type HandCategory = z.infer<typeof HandCategorySchema>;

/** 1 for a high card, 9 for a straight flush. 0 means "never shown one down". */
export function handCategoryRank(category: HandCategory | null): number {
  if (category === null) return 0;
  return HAND_CATEGORY_ORDER.indexOf(category) + 1;
}

/** The inverse, for reading a rank back off a sorted set. */
export function handCategoryFromRank(rank: number): HandCategory | null {
  return HAND_CATEGORY_ORDER[Math.round(rank) - 1] ?? null;
}

const HAND_CATEGORY_LABELS: Readonly<Record<HandCategory, string>> = {
  HIGH_CARD: 'High card',
  PAIR: 'Pair',
  TWO_PAIR: 'Two pair',
  TRIPS: 'Three of a kind',
  STRAIGHT: 'Straight',
  FLUSH: 'Flush',
  FULL_HOUSE: 'Full house',
  QUADS: 'Four of a kind',
  STRAIGHT_FLUSH: 'Straight flush',
};

export function handCategoryLabel(category: HandCategory | null): string {
  return category === null ? '—' : HAND_CATEGORY_LABELS[category];
}

/* ------------------------------------------------------------------ *
 * A player's counters                                                 *
 * ------------------------------------------------------------------ */

/**
 * Everything counted about one player over one stretch of time.
 *
 * `netChips` is a signed total and is the one number here that can go down. It
 * is a `bigint` in Postgres and a plain number on the wire: a play-money chip
 * count that overflowed a double would need more hands than there is time to
 * play them, and JSON has no bigint.
 *
 * `bestHandCategory` only ever counts a hand that was actually turned over at a
 * showdown. A hand that mucked is its owner's (CLAUDE.md §1) — mucking is a
 * refusal to publish, not a delay on publication, and a statistic quietly built
 * out of hidden cards would be publishing them by another route.
 */
export const PlayerStatCardSchema = z.object({
  handsPlayed: z.number().int().nonnegative(),
  handsWon: z.number().int().nonnegative(),
  showdownsSeen: z.number().int().nonnegative(),
  showdownsWon: z.number().int().nonnegative(),
  netChips: z.number().int(),
  biggestPot: z.number().int().nonnegative(),
  bestHandCategory: HandCategorySchema.nullable(),
  bestHandAt: z.iso.datetime().nullable(),
  totalWagered: z.number().int().nonnegative(),
  longestWinStreak: z.number().int().nonnegative(),
  currentWinStreak: z.number().int().nonnegative(),
  /** Hand-weighted average big blind, for BB/100. See `bbPer100`. */
  bigBlind: z.number().nonnegative(),
  updatedAt: z.iso.datetime().nullable(),
});
export type PlayerStatCard = z.infer<typeof PlayerStatCardSchema>;

export const EMPTY_STAT_CARD: PlayerStatCard = {
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
  bigBlind: 0,
  updatedAt: null,
};

/** The value a given metric reads off a stat card. One definition, both sides. */
export function metricValue(metric: LeaderboardMetric, stats: PlayerStatCard): number {
  switch (metric) {
    case 'net':
      return stats.netChips;
    case 'hands':
      return stats.handsPlayed;
    case 'winRate':
      return winRatePercent(stats.handsWon, stats.handsPlayed);
    case 'bb100':
      return bbPer100(stats.netChips, stats.bigBlind, stats.handsPlayed);
    case 'biggestPot':
      return stats.biggestPot;
    case 'bestHand':
      return handCategoryRank(stats.bestHandCategory);
  }
}

/* ------------------------------------------------------------------ *
 * The board, and one player's page                                    *
 * ------------------------------------------------------------------ */

export const LeaderboardEntrySchema = z.object({
  /**
   * One-based, and null for somebody who is on the board only because they are
   * looking at it: a viewer under the threshold for a rate metric is shown their
   * own row with `handsToQualify` instead of a position.
   */
  rank: z.number().int().positive().nullable(),
  userId: z.uuid(),
  displayName: z.string(),
  avatarSeed: z.string().nullable(),
  /** The ranked metric's value, already computed. */
  value: z.number(),
  qualified: z.boolean(),
  handsToQualify: z.number().int().nonnegative(),
  /** Every metric for this player, so the board can show the other columns. */
  stats: PlayerStatCardSchema,
});
export type LeaderboardEntry = z.infer<typeof LeaderboardEntrySchema>;

export const LeaderboardResponseSchema = z.object({
  metric: LeaderboardMetricSchema,
  period: LeaderboardPeriodSchema,
  /** `alltime`, `2026-09`, `2026-W36` — the key this board was read from. */
  periodKey: z.string(),
  entries: z.array(LeaderboardEntrySchema),
  /**
   * The viewer's own row, whether or not it is in `entries`. Null when they have
   * not finished a hand in this period.
   */
  viewer: LeaderboardEntrySchema.nullable(),
  /** When this answer was computed. It is cached for thirty seconds. */
  computedAt: z.iso.datetime(),
  /**
   * True when the fast index could not be reached and the answer came straight
   * from Postgres instead. Slower, equally correct, and worth saying out loud —
   * the same honesty `statsPaused` shows on the history page.
   */
  degraded: z.boolean(),
});
export type LeaderboardResponse = z.infer<typeof LeaderboardResponseSchema>;

/** One line of a player's recent form. Carries no cards — see §1. */
export const PlayerHandSchema = z.object({
  handId: z.uuid(),
  tableCode: z.string(),
  handNumber: z.number().int().positive(),
  endedAt: z.iso.datetime().nullable(),
  bigBlind: z.number().int().positive(),
  totalPot: z.number().int().nonnegative(),
  net: z.number().int().nullable(),
  wentToShowdown: z.boolean(),
  won: z.boolean(),
});
export type PlayerHand = z.infer<typeof PlayerHandSchema>;

export const PlayerProfileResponseSchema = z.object({
  userId: z.uuid(),
  displayName: z.string(),
  avatarSeed: z.string().nullable(),
  /** All-time counters. The period boards are on `/leaderboard`. */
  stats: PlayerStatCardSchema,
  /** Rank on each metric, all-time. Null where they do not qualify. */
  ranks: z.record(LeaderboardMetricSchema, z.number().int().positive().nullable()),
  recentHands: z.array(PlayerHandSchema),
});
export type PlayerProfileResponse = z.infer<typeof PlayerProfileResponseSchema>;

/** How many hands a player's page lists. */
export const PLAYER_RECENT_HANDS = 20;
