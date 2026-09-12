import { and, desc, eq, isNull } from 'drizzle-orm';
import type { Database } from '../db/client';
import { handActions, handPlayers, hands, tableSessions, tables, users } from '../db/schema';
import type { HistoryRecord } from './records';
import type { HistorySink, StoredHand, StoredHandAction, StoredHandPlayer } from './sink';

/**
 * The record of play, in Postgres.
 *
 * The one paragraph in this file that matters is `hand-ended`. Hole cards and
 * `ended_at` are written in a single transaction, so there is no instant at
 * which the database holds one without the other. A backup, a replica or a
 * `select *` taken while a hand is in play finds `hole_cards` null for every
 * seat — not because anything filters them out, but because they have not been
 * written yet.
 *
 * Nothing here is on the path of a hand. `HistoryRecorder` owns the queue and
 * the retries; this only has to be correct, not fast.
 */
export function createPostgresHistorySink(db: Database, close: () => Promise<void>): HistorySink {
  const tableIdFor = async (code: string): Promise<string> => {
    const [row] = await db.select({ id: tables.id }).from(tables).where(eq(tables.code, code));
    if (!row) throw new Error(`no table row for ${code}`);
    return row.id;
  };

  return {
    async write(record: HistoryRecord): Promise<void> {
      switch (record.kind) {
        case 'table-opened':
          await db
            .insert(tables)
            .values({
              code: record.code,
              hostUserId: record.hostUserId,
              config: record.config,
              status: 'open',
              createdAt: record.at,
            })
            .onConflictDoNothing({ target: tables.code });
          return;

        case 'table-closed':
          await db
            .update(tables)
            .set({ status: 'closed', closedAt: record.at })
            .where(eq(tables.code, record.code));
          return;

        case 'session-started':
          await db.insert(tableSessions).values({
            tableId: await tableIdFor(record.code),
            userId: record.userId,
            seatIndex: record.seatIndex,
            buyIn: record.buyIn,
            joinedAt: record.at,
          });
          return;

        case 'session-ended': {
          // The seat they are leaving is the one they are still sitting in.
          const tableId = await tableIdFor(record.code);
          await db
            .update(tableSessions)
            .set({ cashOut: record.cashOut, leftAt: record.at })
            .where(
              and(
                eq(tableSessions.tableId, tableId),
                eq(tableSessions.userId, record.userId),
                isNull(tableSessions.leftAt),
              ),
            );
          return;
        }

        case 'hand-started': {
          const tableId = await tableIdFor(record.code);
          await db.transaction(async (tx) => {
            await tx.insert(hands).values({
              id: record.handId,
              tableId,
              handNumber: record.handNumber,
              buttonSeat: record.buttonSeat,
              smallBlind: record.smallBlind,
              bigBlind: record.bigBlind,
              board: [],
              totalPot: 0,
              // Deliberately absent. The commitment goes out now; the seed that
              // opens it goes in when the hand is over and not one moment sooner.
              deckSeed: null,
              deckCommit: record.deckCommit,
              startedAt: record.at,
              endedAt: null,
            });

            await tx.insert(handPlayers).values(
              record.players.map((player) => ({
                handId: record.handId,
                userId: player.userId,
                seatIndex: player.seatIndex,
                // Null. See the note at the top of this file.
                holeCards: null,
                startingStack: player.startingStack,
              })),
            );
          });
          return;
        }

        case 'hand-action':
          await db
            .insert(handActions)
            .values({
              handId: record.handId,
              seq: record.seq,
              userId: record.userId,
              street: record.street,
              action: record.action,
              amount: record.amount,
              potAfter: record.potAfter,
              elapsedMs: record.elapsedMs,
            })
            .onConflictDoNothing({ target: [handActions.handId, handActions.seq] });
          return;

        case 'hand-ended':
          /*
           * THE TRANSACTION.
           *
           * Everything a finished hand reveals — the seed that opens the deck
           * commitment, and every seat's cards — becomes visible at the same
           * instant the hand is marked finished. Splitting this would create a
           * window where the database says "in progress" and hands out cards.
           */
          await db.transaction(async (tx) => {
            await tx
              .update(hands)
              .set({
                board: [...record.board],
                totalPot: record.totalPot,
                deckSeed: record.deckSeed,
                endedAt: record.at,
              })
              .where(eq(hands.id, record.handId));

            for (const player of record.players) {
              await tx
                .update(handPlayers)
                .set({
                  holeCards: [...player.holeCards],
                  endingStack: player.endingStack,
                  net: player.net,
                  wentToShowdown: player.wentToShowdown,
                  won: player.won,
                })
                .where(
                  and(
                    eq(handPlayers.handId, record.handId),
                    eq(handPlayers.seatIndex, player.seatIndex),
                  ),
                );
            }
          });
          return;
      }
    },

    async recentHands(tableCode: string, limit: number): Promise<StoredHand[]> {
      const rows = await db
        .select({ hand: hands, code: tables.code })
        .from(hands)
        .innerJoin(tables, eq(hands.tableId, tables.id))
        .where(eq(tables.code, tableCode))
        .orderBy(desc(hands.handNumber))
        .limit(limit);

      return Promise.all(rows.map((row) => hydrate(db, row.hand, row.code)));
    },

    async hand(handId: string): Promise<StoredHand | null> {
      const [row] = await db
        .select({ hand: hands, code: tables.code })
        .from(hands)
        .innerJoin(tables, eq(hands.tableId, tables.id))
        .where(eq(hands.id, handId));

      return row ? hydrate(db, row.hand, row.code) : null;
    },

    close,
  };
}

type HandRow = typeof hands.$inferSelect;

async function hydrate(db: Database, hand: HandRow, tableCode: string): Promise<StoredHand> {
  const [players, actions] = await Promise.all([
    db
      .select({ player: handPlayers, displayName: users.displayName })
      .from(handPlayers)
      .innerJoin(users, eq(handPlayers.userId, users.id))
      .where(eq(handPlayers.handId, hand.id))
      .orderBy(handPlayers.seatIndex),
    db
      .select({
        action: handActions,
        displayName: users.displayName,
        seatIndex: handPlayers.seatIndex,
      })
      .from(handActions)
      .leftJoin(users, eq(handActions.userId, users.id))
      .leftJoin(
        handPlayers,
        and(eq(handPlayers.handId, handActions.handId), eq(handPlayers.userId, handActions.userId)),
      )
      .where(eq(handActions.handId, hand.id))
      .orderBy(handActions.seq),
  ]);

  const storedPlayers: StoredHandPlayer[] = players.map(({ player, displayName }) => ({
    userId: player.userId,
    seatIndex: player.seatIndex,
    displayName,
    holeCards: player.holeCards,
    startingStack: player.startingStack,
    endingStack: player.endingStack,
    net: player.net,
    wentToShowdown: player.wentToShowdown,
    won: player.won,
  }));

  const storedActions: StoredHandAction[] = actions.map(({ action, displayName, seatIndex }) => ({
    seq: action.seq,
    userId: action.userId,
    seatIndex,
    displayName: displayName ?? '',
    street: action.street as StoredHandAction['street'],
    action: action.action,
    amount: action.amount,
    potAfter: action.potAfter,
    elapsedMs: action.elapsedMs,
  }));

  return {
    id: hand.id,
    tableCode,
    handNumber: hand.handNumber,
    buttonSeat: hand.buttonSeat,
    smallBlind: hand.smallBlind,
    bigBlind: hand.bigBlind,
    board: hand.board,
    totalPot: hand.totalPot,
    deckSeed: hand.deckSeed,
    deckCommit: hand.deckCommit,
    startedAt: hand.startedAt,
    endedAt: hand.endedAt,
    players: storedPlayers,
    actions: storedActions,
  };
}
