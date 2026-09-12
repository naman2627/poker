import { desc, sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * The phone number is the identity: mandatory, unique, and the only thing a
 * login needs. Email is optional, so its uniqueness is enforced by a partial
 * index that ignores the rows without one.
 */
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** E.164, normalised before it ever reaches this table. */
    phone: text('phone').notNull().unique(),
    phoneVerified: boolean('phone_verified').notNull().default(false),
    email: text('email'),
    emailVerified: boolean('email_verified').notNull().default(false),
    /**
     * Empty until the player completes their profile. The column is NOT NULL
     * because a seat at a table always has a name to show; the empty string is
     * what "not chosen yet" looks like, and it is what blocks joining a table.
     */
    displayName: text('display_name').notNull().default(''),
    avatarSeed: text('avatar_seed'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('users_email_unique')
      .on(table.email)
      .where(sql`${table.email} is not null`),
  ],
);

/**
 * One row per issued refresh token, hashed.
 *
 * `familyId` chains every rotation of one login together. Rotating a token
 * revokes the old row and points `replacedBy` at the new one; presenting a row
 * that is already revoked means the token leaked, and the whole family goes.
 */
export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** HMAC-SHA256 of the token. The token itself is never stored. */
    tokenHash: text('token_hash').notNull().unique(),
    familyId: uuid('family_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    replacedBy: uuid('replaced_by'),
  },
  (table) => [
    index('refresh_tokens_user_idx').on(table.userId),
    index('refresh_tokens_family_idx').on(table.familyId),
  ],
);

/* ------------------------------------------------------------------ *
 * The record of play                                                  *
 *                                                                     *
 * Five tables that together make a hand auditable, replayable and      *
 * countable. Nothing here is on the path of a hand: the runtime hands  *
 * rows to a queue and carries on, and a database that is down stops    *
 * the statistics, never the table. See `history/recorder.ts`.          *
 * ------------------------------------------------------------------ */

export const tables = pgTable(
  'tables',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** The six characters players type. Unique among live and closed tables alike. */
    code: text('code').notNull().unique(),
    hostUserId: uuid('host_user_id').references(() => users.id, { onDelete: 'set null' }),
    /** Blinds, seat count, buy-in range, action timer — as the table was created. */
    config: jsonb('config').notNull(),
    status: text('status').notNull().default('open'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
  },
  (table) => [index('tables_host_idx').on(table.hostUserId)],
);

/**
 * One row per stretch a player spent at a table.
 *
 * `cashOut` is null while they are still sitting there. Standing up and sitting
 * back down is two rows, which is what makes "what did that session cost me"
 * answerable.
 */
export const tableSessions = pgTable(
  'table_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tableId: uuid('table_id')
      .notNull()
      .references(() => tables.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    seatIndex: smallint('seat_index').notNull(),
    buyIn: integer('buy_in').notNull(),
    cashOut: integer('cash_out'),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
    leftAt: timestamp('left_at', { withTimezone: true }),
  },
  (table) => [
    index('table_sessions_table_idx').on(table.tableId),
    index('table_sessions_user_idx').on(table.userId),
  ],
);

/**
 * One hand.
 *
 * `deckCommit` is written before the cards come out; `deckSeed` is written when
 * the hand is over, in the transaction that sets `endedAt`. Between those two
 * moments the commitment is public and the seed is not, which is the whole of
 * the fairness claim: nobody — including this server — can change what was
 * dealt after committing to it, and nobody can work out what was dealt before
 * the reveal.
 */
export const hands = pgTable(
  'hands',
  {
    id: uuid('id').primaryKey(),
    tableId: uuid('table_id')
      .notNull()
      .references(() => tables.id, { onDelete: 'cascade' }),
    handNumber: integer('hand_number').notNull(),
    buttonSeat: smallint('button_seat').notNull(),
    smallBlind: integer('small_blind').notNull(),
    bigBlind: integer('big_blind').notNull(),
    /** The community cards, as short codes: `["Ks","9h","4d"]`. */
    board: text('board')
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    totalPot: integer('total_pot').notNull().default(0),
    /** Null until the hand is over. Publishing it early would publish the deck. */
    deckSeed: text('deck_seed'),
    /** sha256(deckSeed), published before the deal. */
    deckCommit: text('deck_commit').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('hands_table_number_unique').on(table.tableId, table.handNumber),
    index('hands_table_started_idx').on(table.tableId, table.startedAt),
  ],
);

/**
 * One row per seat dealt into a hand.
 *
 * THE RULE (CLAUDE.md §1, at rest rather than on the wire): `holeCards` is null
 * from the moment this row is written until the hand is over, and it is filled
 * in the same transaction that sets `hands.endedAt`. A dump taken mid-hand — a
 * backup, a replica, a curious `select *` — contains nobody's cards, because
 * they are not there yet. `history/repository.ts` is the only file that writes
 * this column, and `test/history-repository.test.ts` is what holds it to that.
 */
export const handPlayers = pgTable(
  'hand_players',
  {
    handId: uuid('hand_id')
      .notNull()
      .references(() => hands.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    seatIndex: smallint('seat_index').notNull(),
    /** Null while the hand is live. See the note above. */
    holeCards: text('hole_cards').array(),
    startingStack: integer('starting_stack').notNull(),
    endingStack: integer('ending_stack'),
    net: integer('net'),
    wentToShowdown: boolean('went_to_showdown').notNull().default(false),
    won: boolean('won').notNull().default(false),
  },
  (table) => [
    primaryKey({ columns: [table.handId, table.seatIndex] }),
    index('hand_players_user_idx').on(table.userId),
  ],
);

/**
 * Every action in a hand, in order.
 *
 * This is what a replay is made of, so it records what a spectator could have
 * seen and not a card more: who acted, on which street, for how much, and what
 * the pot stood at afterwards. `elapsedMs` is measured from the start of the
 * hand, which is what lets a replay run at the speed it was played.
 */
export const handActions = pgTable(
  'hand_actions',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    handId: uuid('hand_id')
      .notNull()
      .references(() => hands.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    street: text('street').notNull(),
    action: text('action').notNull(),
    amount: integer('amount').notNull().default(0),
    potAfter: integer('pot_after').notNull().default(0),
    elapsedMs: integer('elapsed_ms').notNull().default(0),
  },
  (table) => [uniqueIndex('hand_actions_hand_seq_unique').on(table.handId, table.seq)],
);

/* ------------------------------------------------------------------ *
 * The count of play                                                   *
 *                                                                     *
 * Postgres is the source of truth for every leaderboard. Redis holds a *
 * mirror of these two tables in sorted sets so a top-fifty is one      *
 * round trip, and `stats/rebuild.ts` regenerates every one of those    *
 * sets from these rows on boot and hourly — so an evicted, flushed or  *
 * simply absent Redis costs latency and never data.                    *
 *                                                                     *
 * Both tables are written in the same transaction that ends a hand.    *
 * Nothing reads `hand_actions` to build a board, ever: that table is a *
 * replay log with a row per action, and scanning it per request is the *
 * mistake these two tables exist to make unnecessary.                  *
 * ------------------------------------------------------------------ */

/**
 * One row per player, for all time.
 *
 * `netChips` is signed and is a bigint because it is the one counter with no
 * floor — a long-running account can accumulate more swing than an `integer`
 * holds, and a wrapped chip count would be a leaderboard that lies.
 *
 * `bigBlindSum` is the quiet one and it earns its place: BB/100 is
 * `net_chips / big_blind / hands_played * 100`, and a player who has moved
 * between stakes has no single big blind. Summing each hand's blind as it is
 * counted gives `bigBlindSum / handsPlayed` — the blind those hands were
 * actually played for. For a player who has only ever sat at one table it is
 * exactly that table's big blind, and the formula is unchanged.
 *
 * `bestHandCategory` counts only hands that were turned face up at a showdown.
 * A mucked hand stays its owner's (CLAUDE.md §1), and a statistic built out of
 * cards nobody was shown would be publishing them the long way round.
 */
export const playerStats = pgTable(
  'player_stats',
  {
    userId: uuid('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    handsPlayed: integer('hands_played').notNull().default(0),
    handsWon: integer('hands_won').notNull().default(0),
    showdownsSeen: integer('showdowns_seen').notNull().default(0),
    showdownsWon: integer('showdowns_won').notNull().default(0),
    /** Signed, and the only counter here that can go down. */
    netChips: bigint('net_chips', { mode: 'number' }).notNull().default(0),
    biggestPot: integer('biggest_pot').notNull().default(0),
    /** `QUADS`, `FLUSH`, … — the engine's `HandCategory`, shown-down only. */
    bestHandCategory: text('best_hand_category'),
    bestHandAt: timestamp('best_hand_at', { withTimezone: true }),
    totalWagered: bigint('total_wagered', { mode: 'number' }).notNull().default(0),
    longestWinStreak: integer('longest_win_streak').notNull().default(0),
    currentWinStreak: integer('current_win_streak').notNull().default(0),
    /** Sum of every counted hand's big blind. See the note above. */
    bigBlindSum: bigint('big_blind_sum', { mode: 'number' }).notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // The orders a board is read in, so a Redis-less answer is still an index
    // scan of a small table rather than a sort of the whole thing.
    index('player_stats_net_idx').on(desc(table.netChips)),
    index('player_stats_hands_idx').on(desc(table.handsPlayed)),
    index('player_stats_pot_idx').on(desc(table.biggestPot)),
  ],
);

/**
 * The same counters, cut by period.
 *
 * `periodKey` is exactly the key the sorted set is named after: `2026-09` for a
 * month, `2026-W36` for an ISO week. All-time lives in `player_stats` and is
 * deliberately not repeated here, so there is one row per player per month and
 * per week and no third copy of the same number.
 *
 * Weekly rows are kept for sixty days to match their sorted set's TTL; nothing
 * prunes them yet, and when something does it is a `delete from … where
 * period_key like '2___-W__' and updated_at < now() - interval '60 days'`.
 */
export const playerStatPeriods = pgTable(
  'player_stat_periods',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** `2026-09` or `2026-W36`. Never `alltime` — that is `player_stats`. */
    periodKey: text('period_key').notNull(),
    handsPlayed: integer('hands_played').notNull().default(0),
    handsWon: integer('hands_won').notNull().default(0),
    showdownsSeen: integer('showdowns_seen').notNull().default(0),
    showdownsWon: integer('showdowns_won').notNull().default(0),
    netChips: bigint('net_chips', { mode: 'number' }).notNull().default(0),
    biggestPot: integer('biggest_pot').notNull().default(0),
    bestHandCategory: text('best_hand_category'),
    bestHandAt: timestamp('best_hand_at', { withTimezone: true }),
    totalWagered: bigint('total_wagered', { mode: 'number' }).notNull().default(0),
    longestWinStreak: integer('longest_win_streak').notNull().default(0),
    currentWinStreak: integer('current_win_streak').notNull().default(0),
    bigBlindSum: bigint('big_blind_sum', { mode: 'number' }).notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.periodKey] }),
    index('player_stat_periods_key_net_idx').on(table.periodKey, desc(table.netChips)),
  ],
);

export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;
export type RefreshTokenRow = typeof refreshTokens.$inferSelect;
export type NewRefreshTokenRow = typeof refreshTokens.$inferInsert;

export type TableRow = typeof tables.$inferSelect;
export type NewTableRow = typeof tables.$inferInsert;
export type TableSessionRow = typeof tableSessions.$inferSelect;
export type NewTableSessionRow = typeof tableSessions.$inferInsert;
export type HandRow = typeof hands.$inferSelect;
export type NewHandRow = typeof hands.$inferInsert;
export type HandPlayerRow = typeof handPlayers.$inferSelect;
export type NewHandPlayerRow = typeof handPlayers.$inferInsert;
export type HandActionRow = typeof handActions.$inferSelect;
export type NewHandActionRow = typeof handActions.$inferInsert;
export type PlayerStatsRow = typeof playerStats.$inferSelect;
export type NewPlayerStatsRow = typeof playerStats.$inferInsert;
export type PlayerStatPeriodRow = typeof playerStatPeriods.$inferSelect;
export type NewPlayerStatPeriodRow = typeof playerStatPeriods.$inferInsert;
