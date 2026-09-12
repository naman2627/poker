import type { PlayerHand } from '@poker/shared';
import type { CardCode, HistoryRecord } from './records';
import type { HistorySink, StoredHand, StoredHandAction, StoredHandPlayer } from './sink';

/**
 * The record of play, in Maps.
 *
 * For running the whole product with no Postgres — the same reason
 * `auth/memory-adapters.ts` exists. It keeps the history page, the replay and
 * the fairness check working on a laptop with nothing installed, and it loses
 * everything when the process does.
 *
 * It is held to the same rule as the real one: hole cards do not appear until
 * the hand is over, and they appear in the same step that ends it.
 */
interface MemoryTable {
  code: string;
  hostUserId: string | null;
  config: unknown;
  status: string;
  createdAt: Date;
  closedAt: Date | null;
}

interface MemoryHand {
  id: string;
  tableCode: string;
  handNumber: number;
  buttonSeat: number;
  smallBlind: number;
  bigBlind: number;
  board: CardCode[];
  totalPot: number;
  deckSeed: string | null;
  deckCommit: string;
  startedAt: Date;
  endedAt: Date | null;
  players: Map<number, StoredHandPlayer>;
  actions: StoredHandAction[];
}

/**
 * The memory sink, plus the two lookups the memory statistics store needs.
 *
 * They are here rather than in a second set of Maps because this sink already
 * holds both facts — who somebody is, and which hands they have finished — and
 * two copies of that would be two things to keep in step. The Postgres pair
 * answer the same questions with a join; these answer them from what is already
 * in front of them.
 */
export interface MemoryHistorySink extends HistorySink {
  /** Display name and avatar, as last seen on a record. */
  profileFor(userId: string): { displayName: string; avatarSeed: string | null } | null;
  /** This player's finished hands, most recent first. */
  handsFor(userId: string, limit: number): PlayerHand[];
}

/**
 * Names come off the records rather than a join, because there is nothing here
 * to join to. The runtime knows them, so it sends them.
 */
export function createMemoryHistorySink(): MemoryHistorySink {
  const names = new Map<string, string>();
  const tables = new Map<string, MemoryTable>();
  const hands = new Map<string, MemoryHand>();
  const sessions: {
    code: string;
    userId: string;
    seatIndex: number;
    buyIn: number;
    cashOut: number | null;
    joinedAt: Date;
    leftAt: Date | null;
  }[] = [];

  const requireHand = (handId: string): MemoryHand => {
    const hand = hands.get(handId);
    if (!hand) throw new Error(`no hand ${handId}`);
    return hand;
  };

  const toStored = (hand: MemoryHand): StoredHand => ({
    id: hand.id,
    tableCode: hand.tableCode,
    handNumber: hand.handNumber,
    buttonSeat: hand.buttonSeat,
    smallBlind: hand.smallBlind,
    bigBlind: hand.bigBlind,
    board: [...hand.board],
    totalPot: hand.totalPot,
    deckSeed: hand.deckSeed,
    deckCommit: hand.deckCommit,
    startedAt: hand.startedAt,
    endedAt: hand.endedAt,
    players: [...hand.players.values()]
      .map((player) => ({ ...player, displayName: names.get(player.userId) ?? player.displayName }))
      .sort((a, b) => a.seatIndex - b.seatIndex),
    actions: hand.actions
      .map((action) => ({
        ...action,
        displayName: action.userId === null ? '' : (names.get(action.userId) ?? action.displayName),
      }))
      .sort((a, b) => a.seq - b.seq),
  });

  return {
    write(record: HistoryRecord): Promise<void> {
      switch (record.kind) {
        case 'table-opened':
          tables.set(record.code, {
            code: record.code,
            hostUserId: record.hostUserId,
            config: record.config,
            status: 'open',
            createdAt: record.at,
            closedAt: null,
          });
          return Promise.resolve();

        case 'table-closed': {
          const table = tables.get(record.code);
          if (table) {
            table.status = 'closed';
            table.closedAt = record.at;
          }
          return Promise.resolve();
        }

        case 'session-started':
          names.set(record.userId, record.displayName);
          sessions.push({
            code: record.code,
            userId: record.userId,
            seatIndex: record.seatIndex,
            buyIn: record.buyIn,
            cashOut: null,
            joinedAt: record.at,
            leftAt: null,
          });
          return Promise.resolve();

        case 'session-ended': {
          const open = [...sessions]
            .reverse()
            .find(
              (session) =>
                session.code === record.code &&
                session.userId === record.userId &&
                session.leftAt === null,
            );
          if (open) {
            open.cashOut = record.cashOut;
            open.leftAt = record.at;
          }
          return Promise.resolve();
        }

        case 'hand-started':
          if (!tables.has(record.code)) throw new Error(`no table ${record.code}`);
          for (const player of record.players) {
            if (player.displayName !== '') names.set(player.userId, player.displayName);
          }
          hands.set(record.handId, {
            id: record.handId,
            tableCode: record.code,
            handNumber: record.handNumber,
            buttonSeat: record.buttonSeat,
            smallBlind: record.smallBlind,
            bigBlind: record.bigBlind,
            board: [],
            totalPot: 0,
            // Not yet. Publishing the seed now would publish the deck.
            deckSeed: null,
            deckCommit: record.deckCommit,
            startedAt: record.at,
            endedAt: null,
            players: new Map(
              record.players.map((player) => [
                player.seatIndex,
                {
                  userId: player.userId,
                  seatIndex: player.seatIndex,
                  displayName: player.displayName,
                  // Null until the hand is over, exactly as in Postgres.
                  holeCards: null,
                  startingStack: player.startingStack,
                  endingStack: null,
                  net: null,
                  wentToShowdown: false,
                  won: false,
                },
              ]),
            ),
            actions: [],
          });
          return Promise.resolve();

        case 'hand-action': {
          const hand = requireHand(record.handId);
          const seat =
            [...hand.players.values()].find((player) => player.userId === record.userId)
              ?.seatIndex ?? null;

          hand.actions.push({
            seq: record.seq,
            userId: record.userId,
            seatIndex: seat,
            displayName: '',
            street: record.street,
            action: record.action,
            amount: record.amount,
            potAfter: record.potAfter,
            elapsedMs: record.elapsedMs,
          });
          return Promise.resolve();
        }

        case 'hand-ended': {
          // One step, like the transaction it stands in for: the cards and the
          // ending time become true together, and neither before the other.
          const hand = requireHand(record.handId);

          hand.board = [...record.board];
          hand.totalPot = record.totalPot;
          hand.deckSeed = record.deckSeed;
          hand.endedAt = record.at;

          for (const result of record.players) {
            const player = hand.players.get(result.seatIndex);
            if (!player) continue;
            hand.players.set(result.seatIndex, {
              ...player,
              holeCards: [...result.holeCards],
              endingStack: result.endingStack,
              net: result.net,
              wentToShowdown: result.wentToShowdown,
              won: result.won,
            });
          }
          return Promise.resolve();
        }
      }
    },

    recentHands(tableCode: string, limit: number): Promise<StoredHand[]> {
      const found = [...hands.values()]
        .filter((hand) => hand.tableCode === tableCode)
        .sort((a, b) => b.handNumber - a.handNumber)
        .slice(0, limit)
        .map(toStored);
      return Promise.resolve(found);
    },

    hand(handId: string): Promise<StoredHand | null> {
      const found = hands.get(handId);
      return Promise.resolve(found ? toStored(found) : null);
    },

    profileFor(userId: string) {
      const displayName = names.get(userId);
      // Avatars are not carried on the records, so the memory build shows
      // initials. Postgres has the column and joins to it.
      return displayName === undefined ? null : { displayName, avatarSeed: null };
    },

    handsFor(userId: string, limit: number): PlayerHand[] {
      return [...hands.values()]
        .filter((hand) => hand.endedAt !== null)
        .filter((hand) => [...hand.players.values()].some((player) => player.userId === userId))
        .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
        .slice(0, limit)
        .flatMap((hand) => {
          const mine = [...hand.players.values()].find((player) => player.userId === userId);
          if (!mine) return [];
          return [
            {
              handId: hand.id,
              tableCode: hand.tableCode,
              handNumber: hand.handNumber,
              endedAt: hand.endedAt === null ? null : hand.endedAt.toISOString(),
              bigBlind: hand.bigBlind,
              totalPot: hand.totalPot,
              net: mine.net,
              wentToShowdown: mine.wentToShowdown,
              won: mine.won,
            },
          ];
        });
    },

    close: () => Promise.resolve(),
  };
}
