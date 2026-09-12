import { and, desc, eq, gte, inArray, isNotNull, sql, type SQL } from 'drizzle-orm';
import {
  MIN_RANKED_HANDS,
  HAND_CATEGORY_ORDER,
  handCategoryRank,
  type HandCategory,
  type LeaderboardMetric,
  type PlayerHand,
} from '@poker/shared';
import type { Database } from '../db/client';
import { handPlayers, hands, playerStatPeriods, playerStats, tables, users } from '../db/schema';
import type { PlayerHandDelta, StatCounters } from './delta';
import { ALLTIME_KEY } from './periods';
import type {
  AppliedEntry,
  AppliedHand,
  StatsProfile,
  StatsSnapshotRow,
  StatsStore,
} from './ports';

/**
 * The counters, in Postgres. The source of truth for every leaderboard.
 *
 * `applyHand` is the only writer and it is one transaction: every player in the
 * hand, across all-time, the month and the week, or none of them. A hand
 * half-counted would leave a player's monthly net permanently out of step with
 * their all-time net, and no later write would ever notice.
 *
 * Each row is moved by a single `insert … on conflict do update`, with every
 * value written in terms of the row's own current value. Nothing is read into
 * Node and written back, so there is no lost update to worry about and the
 * non-additive rules survive concurrency intact:
 *
 *   - `biggest_pot` is a `greatest()` — a maximum, not a total
 *   - the streak is "whatever it was, plus one" on a win and a flat zero on a
 *     loss, with `longest` the `greatest()` of the two
 *   - the best hand compares by the engine's category *order*, carried into SQL
 *     as an array so `array_position` can rank it, and ties keep the row as it
 *     stands — the first time you made quads is the one worth the date
 *
 * Nothing here is on the path of a hand. `HistoryRecorder` owns the queue and
 * the retries; a database that is down means the statistics are behind, never
 * that the table stopped.
 */
export function createPostgresStatsStore(db: Database, close: () => Promise<void>): StatsStore {
  const readCounters = async (userId: string, periodKey: string): Promise<StatCounters | null> => {
    const [row] =
      periodKey === ALLTIME_KEY
        ? await db.select(projectAlltime()).from(playerStats).where(eq(playerStats.userId, userId))
        : await db
            .select(projectPeriod())
            .from(playerStatPeriods)
            .where(
              and(eq(playerStatPeriods.userId, userId), eq(playerStatPeriods.periodKey, periodKey)),
            );

    return row ? countersOf(row) : null;
  };

  return {
    async applyHand(deltas: readonly PlayerHandDelta[]): Promise<AppliedHand> {
      if (deltas.length === 0) return { entries: [] };

      const entries: AppliedEntry[] = [];

      await db.transaction(async (tx) => {
        for (const delta of deltas) {
          for (const periodKey of delta.periodKeys) {
            const counters =
              periodKey === ALLTIME_KEY
                ? await upsertAlltime(tx, delta)
                : await upsertPeriod(tx, delta, periodKey);

            entries.push({ userId: delta.userId, periodKey, delta, counters });
          }
        }
      });

      return { entries };
    },

    async snapshot(periodKey: string): Promise<StatsSnapshotRow[]> {
      const rows =
        periodKey === ALLTIME_KEY
          ? await db.select(projectAlltime()).from(playerStats)
          : await db
              .select(projectPeriod())
              .from(playerStatPeriods)
              .where(eq(playerStatPeriods.periodKey, periodKey));

      return rows.map(toSnapshotRow);
    },

    async periodKeys(): Promise<string[]> {
      const rows = await db
        .selectDistinct({ periodKey: playerStatPeriods.periodKey })
        .from(playerStatPeriods);
      return [ALLTIME_KEY, ...rows.map((row) => row.periodKey)];
    },

    counters(userId: string, periodKey: string): Promise<StatCounters | null> {
      return readCounters(userId, periodKey);
    },

    async countersMany(
      userIds: readonly string[],
      periodKey: string,
    ): Promise<Map<string, StatCounters>> {
      if (userIds.length === 0) return new Map();

      const rows =
        periodKey === ALLTIME_KEY
          ? await db
              .select(projectAlltime())
              .from(playerStats)
              .where(inArray(playerStats.userId, [...userIds]))
          : await db
              .select(projectPeriod())
              .from(playerStatPeriods)
              .where(
                and(
                  inArray(playerStatPeriods.userId, [...userIds]),
                  eq(playerStatPeriods.periodKey, periodKey),
                ),
              );

      return new Map(rows.map((row) => [row.userId, countersOf(row)]));
    },

    async profiles(userIds: readonly string[]): Promise<Map<string, StatsProfile>> {
      if (userIds.length === 0) return new Map();

      const rows = await db
        .select({ id: users.id, displayName: users.displayName, avatarSeed: users.avatarSeed })
        .from(users)
        .where(inArray(users.id, [...userIds]));

      return new Map(
        rows.map((row) => [
          row.id,
          { userId: row.id, displayName: row.displayName, avatarSeed: row.avatarSeed },
        ]),
      );
    },

    async top(
      metric: LeaderboardMetric,
      periodKey: string,
      limit: number,
    ): Promise<StatsSnapshotRow[]> {
      const rows =
        periodKey === ALLTIME_KEY
          ? await db
              .select(projectAlltime())
              .from(playerStats)
              .where(qualifier(metric, ALLTIME_COLUMNS))
              .orderBy(desc(score(metric, ALLTIME_COLUMNS)))
              .limit(limit)
          : await db
              .select(projectPeriod())
              .from(playerStatPeriods)
              .where(
                combine(
                  eq(playerStatPeriods.periodKey, periodKey),
                  qualifier(metric, PERIOD_COLUMNS),
                ),
              )
              .orderBy(desc(score(metric, PERIOD_COLUMNS)))
              .limit(limit);

      return rows.map(toSnapshotRow);
    },

    async rank(
      userId: string,
      metric: LeaderboardMetric,
      periodKey: string,
    ): Promise<number | null> {
      const mine = await readCounters(userId, periodKey);
      if (mine === null) return null;
      if (!qualifies(metric, mine)) return null;

      const value = scoreOf(metric, mine);
      const columns = periodKey === ALLTIME_KEY ? ALLTIME_COLUMNS : PERIOD_COLUMNS;
      const scoped =
        periodKey === ALLTIME_KEY ? undefined : eq(playerStatPeriods.periodKey, periodKey);

      // "How many qualifying players are strictly ahead of me", plus one — so a
      // tie shares a rank, which is what a reader expects of a board.
      const where = combine(
        scoped,
        qualifier(metric, columns),
        sql`${score(metric, columns)} > ${value}`,
      );

      const [ahead] =
        periodKey === ALLTIME_KEY
          ? await db.select({ count: COUNT }).from(playerStats).where(where)
          : await db.select({ count: COUNT }).from(playerStatPeriods).where(where);

      return (ahead?.count ?? 0) + 1;
    },

    async recentHands(userId: string, limit: number): Promise<PlayerHand[]> {
      // Indexed by `hand_players_user_idx` and joined to the hand for its board
      // and its blinds. `hand_actions` is not touched: aggregating a per-action
      // log on a request is exactly what the counters above exist to avoid.
      const rows = await db
        .select({
          handId: hands.id,
          tableCode: tables.code,
          handNumber: hands.handNumber,
          endedAt: hands.endedAt,
          bigBlind: hands.bigBlind,
          totalPot: hands.totalPot,
          net: handPlayers.net,
          wentToShowdown: handPlayers.wentToShowdown,
          won: handPlayers.won,
        })
        .from(handPlayers)
        .innerJoin(hands, eq(handPlayers.handId, hands.id))
        .innerJoin(tables, eq(hands.tableId, tables.id))
        .where(and(eq(handPlayers.userId, userId), isNotNull(hands.endedAt)))
        .orderBy(desc(hands.startedAt))
        .limit(limit);

      return rows.map((row) => ({
        handId: row.handId,
        tableCode: row.tableCode,
        handNumber: row.handNumber,
        endedAt: row.endedAt === null ? null : row.endedAt.toISOString(),
        bigBlind: row.bigBlind,
        totalPot: row.totalPot,
        net: row.net,
        wentToShowdown: row.wentToShowdown,
        won: row.won,
      }));
    },

    close,
  };
}

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

const COUNT = sql<number>`count(*)::int`;

/* ------------------------------------------------------------------ *
 * Writing                                                             *
 * ------------------------------------------------------------------ */

async function upsertAlltime(tx: Tx, delta: PlayerHandDelta): Promise<StatCounters> {
  const [row] = await tx
    .insert(playerStats)
    .values({ userId: delta.userId, ...seed(delta) })
    .onConflictDoUpdate({ target: playerStats.userId, set: updates(ALLTIME_COLUMNS, delta) })
    .returning(projectAlltime());

  return row ? countersOf(row) : fallback(delta);
}

async function upsertPeriod(
  tx: Tx,
  delta: PlayerHandDelta,
  periodKey: string,
): Promise<StatCounters> {
  const [row] = await tx
    .insert(playerStatPeriods)
    .values({ userId: delta.userId, periodKey, ...seed(delta) })
    .onConflictDoUpdate({
      target: [playerStatPeriods.userId, playerStatPeriods.periodKey],
      set: updates(PERIOD_COLUMNS, delta),
    })
    .returning(projectPeriod());

  return row ? countersOf(row) : fallback(delta);
}

/** The row a player's very first counted hand in this period creates. */
function seed(delta: PlayerHandDelta) {
  const streak = delta.won ? 1 : 0;
  return {
    handsPlayed: delta.handsPlayed,
    handsWon: delta.handsWon,
    showdownsSeen: delta.showdownsSeen,
    showdownsWon: delta.showdownsWon,
    netChips: delta.netChips,
    biggestPot: delta.potWon,
    bestHandCategory: delta.shownCategory,
    bestHandAt: delta.shownCategory === null ? null : delta.at,
    totalWagered: delta.totalWagered,
    longestWinStreak: streak,
    currentWinStreak: streak,
    bigBlindSum: delta.bigBlindSum,
    updatedAt: delta.at,
  };
}

/**
 * What an existing row moves by, entirely in terms of itself.
 *
 * The best-hand clause looks heavier than it is: `CATEGORY_ARRAY` is the
 * engine's nine categories weakest first, so `array_position` turns a name into
 * a strength and the `case` keeps whichever is stronger. A row that has never
 * shown a hand down has `null` there, and `coalesce(…, 0)` makes any real
 * category beat it.
 */
function updates(columns: StatColumns, delta: PlayerHandDelta) {
  const nextStreak = delta.won ? sql`${columns.currentWinStreak} + 1` : sql`0`;

  const base = {
    handsPlayed: sql`${columns.handsPlayed} + ${delta.handsPlayed}`,
    handsWon: sql`${columns.handsWon} + ${delta.handsWon}`,
    showdownsSeen: sql`${columns.showdownsSeen} + ${delta.showdownsSeen}`,
    showdownsWon: sql`${columns.showdownsWon} + ${delta.showdownsWon}`,
    netChips: sql`${columns.netChips} + ${delta.netChips}`,
    biggestPot: sql`greatest(${columns.biggestPot}, ${delta.potWon})`,
    totalWagered: sql`${columns.totalWagered} + ${delta.totalWagered}`,
    longestWinStreak: sql`greatest(${columns.longestWinStreak}, ${nextStreak})`,
    currentWinStreak: nextStreak,
    bigBlindSum: sql`${columns.bigBlindSum} + ${delta.bigBlindSum}`,
    updatedAt: delta.at,
  };

  // A hand nobody saw cannot improve a "best hand", so the columns are left
  // alone entirely rather than written back to themselves.
  if (delta.shownCategory === null) return base;

  const beatsIt = sql`array_position(${CATEGORY_ARRAY}, ${delta.shownCategory}::text) > coalesce(array_position(${CATEGORY_ARRAY}, ${columns.bestHandCategory}), 0)`;

  return {
    ...base,
    bestHandCategory: sql`case when ${beatsIt} then ${delta.shownCategory}::text else ${columns.bestHandCategory} end`,
    bestHandAt: sql`case when ${beatsIt} then ${delta.at.toISOString()}::timestamptz else ${columns.bestHandAt} end`,
  };
}

/**
 * What the counters must be if the database gave us no row back.
 *
 * It cannot happen — an upsert returns the row it wrote — but the alternative
 * to saying so is a non-null assertion, which this repo does not use.
 */
function fallback(delta: PlayerHandDelta): StatCounters {
  const streak = delta.won ? 1 : 0;
  return {
    handsPlayed: delta.handsPlayed,
    handsWon: delta.handsWon,
    showdownsSeen: delta.showdownsSeen,
    showdownsWon: delta.showdownsWon,
    netChips: delta.netChips,
    biggestPot: delta.potWon,
    bestHandCategory: delta.shownCategory,
    bestHandAt: delta.shownCategory === null ? null : delta.at,
    totalWagered: delta.totalWagered,
    longestWinStreak: streak,
    currentWinStreak: streak,
    bigBlindSum: delta.bigBlindSum,
    updatedAt: delta.at,
  };
}

/* ------------------------------------------------------------------ *
 * Reading                                                             *
 *                                                                     *
 * The two tables carry identical counters, so everything that builds   *
 * an expression takes a `StatColumns` and is written once. Only the    *
 * `select().from()` itself has to know which table it is on.           *
 * ------------------------------------------------------------------ */

interface StatColumns {
  readonly handsPlayed: typeof playerStats.handsPlayed;
  readonly handsWon: typeof playerStats.handsWon;
  readonly showdownsSeen: typeof playerStats.showdownsSeen;
  readonly showdownsWon: typeof playerStats.showdownsWon;
  readonly netChips: typeof playerStats.netChips;
  readonly biggestPot: typeof playerStats.biggestPot;
  readonly bestHandCategory: typeof playerStats.bestHandCategory;
  readonly bestHandAt: typeof playerStats.bestHandAt;
  readonly totalWagered: typeof playerStats.totalWagered;
  readonly longestWinStreak: typeof playerStats.longestWinStreak;
  readonly currentWinStreak: typeof playerStats.currentWinStreak;
  readonly bigBlindSum: typeof playerStats.bigBlindSum;
  readonly updatedAt: typeof playerStats.updatedAt;
}

const ALLTIME_COLUMNS = columnsOf(playerStats);
const PERIOD_COLUMNS = columnsOf(playerStatPeriods);

function columnsOf(table: typeof playerStats | typeof playerStatPeriods): StatColumns {
  return {
    handsPlayed: table.handsPlayed,
    handsWon: table.handsWon,
    showdownsSeen: table.showdownsSeen,
    showdownsWon: table.showdownsWon,
    netChips: table.netChips,
    biggestPot: table.biggestPot,
    bestHandCategory: table.bestHandCategory,
    bestHandAt: table.bestHandAt,
    totalWagered: table.totalWagered,
    longestWinStreak: table.longestWinStreak,
    currentWinStreak: table.currentWinStreak,
    bigBlindSum: table.bigBlindSum,
    updatedAt: table.updatedAt,
    // The two tables differ only in their key columns, which nothing below
    // touches. The cast on PERIOD_COLUMNS above says exactly that: the column
    // objects carry their own table, so the SQL they render is the right one.
  } as StatColumns;
}

const projectAlltime = () => ({ userId: playerStats.userId, ...ALLTIME_COLUMNS });
const projectPeriod = () => ({ userId: playerStatPeriods.userId, ...PERIOD_COLUMNS });

/** A selected row: the counters, plus the account, with the category still raw text. */
type StatSelection = Omit<StatCounters, 'bestHandCategory'> & {
  readonly userId: string;
  readonly bestHandCategory: string | null;
};

function toSnapshotRow(row: StatSelection): StatsSnapshotRow {
  return { userId: row.userId, counters: countersOf(row) };
}

function countersOf(
  row: Omit<StatCounters, 'bestHandCategory'> & { bestHandCategory: string | null },
): StatCounters {
  return {
    handsPlayed: row.handsPlayed,
    handsWon: row.handsWon,
    showdownsSeen: row.showdownsSeen,
    showdownsWon: row.showdownsWon,
    netChips: row.netChips,
    biggestPot: row.biggestPot,
    bestHandCategory: (row.bestHandCategory as HandCategory | null) ?? null,
    bestHandAt: row.bestHandAt,
    totalWagered: row.totalWagered,
    longestWinStreak: row.longestWinStreak,
    currentWinStreak: row.currentWinStreak,
    bigBlindSum: row.bigBlindSum,
    updatedAt: row.updatedAt,
  };
}

/** The engine's category order, weakest first, as a Postgres array. */
const CATEGORY_ARRAY: SQL = sql.raw(
  `ARRAY[${HAND_CATEGORY_ORDER.map((category) => `'${category}'`).join(',')}]::text[]`,
);

/**
 * The expression a metric is ordered by, in the units the board shows.
 *
 * BB/100 is `net / big_blind / hands * 100` where `big_blind` is
 * `big_blind_sum / hands` — the two `hands` cancel, which is why this reads as
 * `net / big_blind_sum * 100`. It is the same number the client computes from
 * the stat card; see `bbPer100` in @poker/shared.
 */
function score(metric: LeaderboardMetric, columns: StatColumns): SQL {
  switch (metric) {
    case 'net':
      return sql`${columns.netChips}`;
    case 'hands':
      return sql`${columns.handsPlayed}`;
    case 'biggestPot':
      return sql`${columns.biggestPot}`;
    case 'winRate':
      return sql`(${columns.handsWon}::numeric / nullif(${columns.handsPlayed}, 0)) * 100`;
    case 'bb100':
      return sql`(${columns.netChips}::numeric / nullif(${columns.bigBlindSum}, 0)) * 100`;
    case 'bestHand':
      return sql`coalesce(array_position(${CATEGORY_ARRAY}, ${columns.bestHandCategory}), 0)`;
  }
}

/** The same score, off counters already in hand. One definition, two callers. */
function scoreOf(metric: LeaderboardMetric, counters: StatCounters): number {
  switch (metric) {
    case 'net':
      return counters.netChips;
    case 'hands':
      return counters.handsPlayed;
    case 'biggestPot':
      return counters.biggestPot;
    case 'winRate':
      return counters.handsPlayed === 0 ? 0 : (counters.handsWon / counters.handsPlayed) * 100;
    case 'bb100':
      return counters.bigBlindSum === 0 ? 0 : (counters.netChips / counters.bigBlindSum) * 100;
    case 'bestHand':
      return handCategoryRank(counters.bestHandCategory);
  }
}

/**
 * THE THRESHOLD, in SQL.
 *
 * A rate metric ranks nobody with fewer than two hundred hands behind them. It
 * is a `where` rather than a filter applied afterwards, so an unqualified player
 * is absent from the ordering *and* from the count of people ahead of everybody
 * else — they never silently occupy a position nobody can see.
 */
function qualifier(metric: LeaderboardMetric, columns: StatColumns): SQL | undefined {
  if (metric === 'winRate' || metric === 'bb100') {
    return gte(columns.handsPlayed, MIN_RANKED_HANDS);
  }
  if (metric === 'bestHand') return isNotNull(columns.bestHandCategory);
  return undefined;
}

/** The same question, off counters already in hand. */
function qualifies(metric: LeaderboardMetric, counters: StatCounters): boolean {
  if (metric === 'winRate' || metric === 'bb100') return counters.handsPlayed >= MIN_RANKED_HANDS;
  if (metric === 'bestHand') return counters.bestHandCategory !== null;
  return true;
}

function combine(...parts: (SQL | undefined)[]): SQL | undefined {
  const present = parts.filter((part): part is SQL => part !== undefined);
  if (present.length === 0) return undefined;
  return present.length === 1 ? present[0] : and(...present);
}
