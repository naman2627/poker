/**
 * The counters and the boards, end to end, in memory.
 *
 * These drive the in-memory store and index rather than a container, which is
 * what lets them assert exact ranks on exact hand counts. The Postgres and Redis
 * implementations answer the same questions with the same rules; the rules
 * themselves are `delta.ts`, which both share.
 */
import { describe, expect, it } from 'vitest';
import { MIN_RANKED_HANDS } from '@poker/shared';
import type { HandEnded } from '../src/history/records';
import { deltasFor } from '../src/stats/delta';
import { createMemoryLeaderboardIndex } from '../src/stats/memory-index';
import { createMemoryStatsStore } from '../src/stats/memory-store';
import { rebuildLeaderboards } from '../src/stats/rebuild';
import type { LeaderboardIndex, StatsStore } from '../src/stats/ports';

const AT = new Date('2026-09-12T12:00:00Z');

const user = (n: number): string => `00000000-0000-4000-8000-00000000000${n.toString(16)}`;

/**
 * A hand between two named players, with the result stated rather than played.
 *
 * The engine is not involved: these tests are about counting, and a hand is
 * exactly the record `TableRuntime` would hand over.
 */
function hand(over: {
  winner: number;
  loser: number;
  pot?: number;
  bigBlind?: number;
  shownCategory?: HandEnded['players'][number]['shownCategory'];
  at?: Date;
}): HandEnded {
  const pot = over.pot ?? 100;
  const at = over.at ?? AT;

  return {
    kind: 'hand-ended',
    handId: '00000000-0000-4000-8000-0000000000ff',
    board: [],
    totalPot: pot,
    deckSeed: 'seed',
    bigBlind: over.bigBlind ?? 10,
    at,
    players: [
      {
        userId: user(over.winner),
        seatIndex: 0,
        holeCards: [],
        shown: over.shownCategory !== undefined,
        shownCategory: over.shownCategory ?? null,
        endingStack: 1000,
        net: pot / 2,
        wagered: pot / 2,
        potWon: pot,
        wentToShowdown: over.shownCategory !== undefined,
        won: true,
      },
      {
        userId: user(over.loser),
        seatIndex: 1,
        holeCards: [],
        shown: false,
        shownCategory: null,
        endingStack: 1000,
        net: -pot / 2,
        wagered: pot / 2,
        potWon: 0,
        wentToShowdown: over.shownCategory !== undefined,
        won: false,
      },
    ],
  };
}

async function play(store: StatsStore, index: LeaderboardIndex, record: HandEnded): Promise<void> {
  const applied = await store.applyHand(deltasFor(record));
  await index.mirror(applied);
}

function fresh(): { store: StatsStore; index: LeaderboardIndex } {
  return { store: createMemoryStatsStore(), index: createMemoryLeaderboardIndex() };
}

describe('counting hands', () => {
  it('writes all-time, the month and the week from one hand', async () => {
    const { store, index } = fresh();
    await play(store, index, hand({ winner: 1, loser: 2 }));

    expect((await store.counters(user(1), 'alltime'))?.netChips).toBe(50);
    expect((await store.counters(user(1), '2026-09'))?.netChips).toBe(50);
    expect((await store.counters(user(1), '2026-W37'))?.netChips).toBe(50);
  });

  it('keeps the periods apart', async () => {
    const { store, index } = fresh();
    await play(store, index, hand({ winner: 1, loser: 2, at: new Date('2026-08-01T12:00:00Z') }));
    await play(store, index, hand({ winner: 1, loser: 2 }));

    expect((await store.counters(user(1), 'alltime'))?.netChips).toBe(100);
    expect((await store.counters(user(1), '2026-09'))?.netChips).toBe(50);
    expect((await store.counters(user(1), '2026-08'))?.netChips).toBe(50);
  });

  it('mirrors net chips into the sorted set as the hands land', async () => {
    const { store, index } = fresh();
    await play(store, index, hand({ winner: 1, loser: 2, pot: 200 }));
    await play(store, index, hand({ winner: 1, loser: 3, pot: 100 }));

    const top = await index.top('net', 'alltime', 50);
    expect(top[0]).toEqual({ userId: user(1), score: 150 });
  });

  it('only ever raises the biggest pot', async () => {
    const { store, index } = fresh();
    await play(store, index, hand({ winner: 1, loser: 2, pot: 400 }));
    await play(store, index, hand({ winner: 1, loser: 2, pot: 60 }));

    expect((await store.counters(user(1), 'alltime'))?.biggestPot).toBe(400);
    expect((await index.top('biggestPot', 'alltime', 50))[0]?.score).toBe(400);
  });

  it('ranks the best hand by category strength', async () => {
    const { store, index } = fresh();
    await play(store, index, hand({ winner: 1, loser: 2, shownCategory: 'PAIR' }));
    await play(store, index, hand({ winner: 2, loser: 1, shownCategory: 'QUADS' }));

    const top = await index.top('bestHand', 'alltime', 50);
    expect(top[0]?.userId).toBe(user(2));
    expect((await store.counters(user(2), 'alltime'))?.bestHandCategory).toBe('QUADS');
  });
});

describe('the two-hundred hand threshold', () => {
  /** `hands` hands, all won by `who`, so the rate is unambiguous. */
  const playHands = async (
    store: StatsStore,
    index: LeaderboardIndex,
    who: number,
    against: number,
    hands: number,
  ): Promise<void> => {
    for (let played = 0; played < hands; played += 1) {
      await play(store, index, hand({ winner: who, loser: against }));
    }
  };

  it('leaves a player under the threshold off a rate board entirely', async () => {
    const { store, index } = fresh();
    await playHands(store, index, 1, 2, 5);

    expect(await index.top('winRate', 'alltime', 50)).toEqual([]);
    expect(await index.rank(user(1), 'winRate', 'alltime')).toBeNull();
    expect(await store.rank(user(1), 'winRate', 'alltime')).toBeNull();
  });

  it('still ranks that player on the totals, which are not ratios', async () => {
    const { store, index } = fresh();
    await playHands(store, index, 1, 2, 5);

    expect(await index.rank(user(1), 'net', 'alltime')).toBe(1);
    expect(await store.rank(user(1), 'hands', 'alltime')).toBe(1);
  });

  it('adds them the moment they cross it', async () => {
    const { store, index } = fresh();
    await playHands(store, index, 1, 2, MIN_RANKED_HANDS - 1);
    expect(await index.rank(user(1), 'winRate', 'alltime')).toBeNull();

    await playHands(store, index, 1, 2, 1);
    expect(await index.rank(user(1), 'winRate', 'alltime')).toBe(1);
    expect(await store.rank(user(1), 'winRate', 'alltime')).toBe(1);
  });

  /**
   * The whole reason the threshold exists: one lucky session must not be able
   * to sit on top of a rate board for ever.
   */
  it('does not let a tiny sample outrank a long one', async () => {
    const { store, index } = fresh();

    // A grinder: two hundred hands, winning two out of every three.
    for (let played = 0; played < MIN_RANKED_HANDS; played += 1) {
      const won = played % 3 !== 0;
      await play(store, index, won ? hand({ winner: 1, loser: 9 }) : hand({ winner: 9, loser: 1 }));
    }

    // Somebody who sat down once and won all three hands they played — a
    // hundred per cent, on a sample that means nothing.
    await playHands(store, index, 2, 9, 3);

    const board = await index.top('winRate', 'alltime', 50);
    expect(board.map((row) => row.userId)).not.toContain(user(2));
    expect(board[0]?.userId).toBe(user(1));
  });
});

describe('BB/100', () => {
  it('measures against the blind the hands were played for', async () => {
    const { store, index } = fresh();

    // Two hundred hands at a big blind of 10, netting +50 each time.
    for (let played = 0; played < MIN_RANKED_HANDS; played += 1) {
      await play(store, index, hand({ winner: 1, loser: 9, pot: 100, bigBlind: 10 }));
    }

    // net 10_000 over 200 hands at bb 10 => 10000/10/200*100 = 500.
    const score = (await index.top('bb100', 'alltime', 50))[0]?.score;
    expect(score).toBeCloseTo(500, 6);

    const counters = await store.counters(user(1), 'alltime');
    expect(counters?.bigBlindSum).toBe(MIN_RANKED_HANDS * 10);
  });
});

describe('rebuildLeaderboards', () => {
  it('reproduces exactly what the live mirror built', async () => {
    const { store, index } = fresh();
    await play(store, index, hand({ winner: 1, loser: 2, pot: 300, shownCategory: 'FLUSH' }));
    await play(store, index, hand({ winner: 2, loser: 1, pot: 80 }));
    await play(store, index, hand({ winner: 3, loser: 1, pot: 120 }));

    const before = await index.top('net', 'alltime', 50);
    const potsBefore = await index.top('biggestPot', 'alltime', 50);

    await rebuildLeaderboards({ store, index });

    expect(await index.top('net', 'alltime', 50)).toEqual(before);
    expect(await index.top('biggestPot', 'alltime', 50)).toEqual(potsBefore);
  });

  /**
   * The point of the job. Redis holds nothing that is not derived, so losing all
   * of it costs a rebuild and not a number.
   */
  it('puts every board back after the index is thrown away', async () => {
    const { store, index } = fresh();
    for (let played = 0; played < MIN_RANKED_HANDS; played += 1) {
      await play(store, index, hand({ winner: 1, loser: 2, pot: 100 }));
    }

    const expected = {
      net: await index.top('net', 'alltime', 50),
      hands: await index.top('hands', 'alltime', 50),
      winRate: await index.top('winRate', 'alltime', 50),
      bb100: await index.top('bb100', 'alltime', 50),
    };

    // Everything gone: an eviction, a flush, or a brand new Redis.
    const evicted = createMemoryLeaderboardIndex();
    expect(await evicted.top('net', 'alltime', 50)).toEqual([]);

    await rebuildLeaderboards({ store, index: evicted });

    expect(await evicted.top('net', 'alltime', 50)).toEqual(expected.net);
    expect(await evicted.top('hands', 'alltime', 50)).toEqual(expected.hands);
    expect(await evicted.top('winRate', 'alltime', 50)).toEqual(expected.winRate);
    expect(await evicted.top('bb100', 'alltime', 50)).toEqual(expected.bb100);
  });

  it('rebuilds the monthly and weekly boards too', async () => {
    const { store, index } = fresh();
    await play(store, index, hand({ winner: 1, loser: 2 }));

    const result = await rebuildLeaderboards({ store, index });

    expect(result.periods).toBe(3);
    expect((await index.top('net', '2026-09', 50))[0]).toEqual({ userId: user(1), score: 50 });
    expect((await index.top('net', '2026-W37', 50))[0]).toEqual({ userId: user(1), score: 50 });
  });

  it('keeps an unqualified player out of the rate boards it rebuilds', async () => {
    const { store, index } = fresh();
    await play(store, index, hand({ winner: 1, loser: 2 }));

    await rebuildLeaderboards({ store, index });

    expect(await index.top('winRate', 'alltime', 50)).toEqual([]);
    expect(await index.top('net', 'alltime', 50)).toHaveLength(2);
  });
});
