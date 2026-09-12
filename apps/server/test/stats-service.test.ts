/**
 * The read side: the cache, the pinned row, and the honest fallback.
 *
 * The clock is injected, so "cached for thirty seconds" is asserted rather than
 * waited for.
 */
import { describe, expect, it } from 'vitest';
import { MIN_RANKED_HANDS } from '@poker/shared';
import type { HandEnded } from '../src/history/records';
import { deltasFor } from '../src/stats/delta';
import { createMemoryLeaderboardIndex } from '../src/stats/memory-index';
import { createMemoryStatsStore } from '../src/stats/memory-store';
import type { LeaderboardIndex, StatsStore } from '../src/stats/ports';
import { LEADERBOARD_CACHE_MS, createStatsService } from '../src/stats/service';

const START = Date.UTC(2026, 8, 12, 12, 0, 0);
const AT = new Date(START);

const user = (n: number): string =>
  `00000000-0000-4000-8000-0000000000${n.toString().padStart(2, '0')}`;

function hand(winner: number, loser: number, pot = 100): HandEnded {
  return {
    kind: 'hand-ended',
    handId: '00000000-0000-4000-8000-0000000000ff',
    board: [],
    totalPot: pot,
    deckSeed: 'seed',
    bigBlind: 10,
    at: AT,
    players: [
      {
        userId: user(winner),
        seatIndex: 0,
        holeCards: [],
        shown: false,
        shownCategory: null,
        endingStack: 1000,
        net: pot / 2,
        wagered: pot / 2,
        potWon: pot,
        wentToShowdown: false,
        won: true,
      },
      {
        userId: user(loser),
        seatIndex: 1,
        holeCards: [],
        shown: false,
        shownCategory: null,
        endingStack: 1000,
        net: -pot / 2,
        wagered: pot / 2,
        potWon: 0,
        wentToShowdown: false,
        won: false,
      },
    ],
  };
}

interface Harness {
  readonly store: StatsStore;
  readonly index: LeaderboardIndex;
  readonly service: ReturnType<typeof createStatsService>;
  tick(ms: number): void;
  play(winner: number, loser: number, pot?: number): Promise<void>;
}

function harness(): Harness {
  let now = START;
  const store = createMemoryStatsStore({
    profileFor: (userId) => ({ displayName: `Player ${userId.slice(-2)}`, avatarSeed: null }),
  });
  const index = createMemoryLeaderboardIndex();

  return {
    store,
    index,
    service: createStatsService({ store, index, now: () => now }),
    tick: (ms: number) => {
      now += ms;
    },
    play: async (winner, loser, pot) => {
      await index.mirror(await store.applyHand(deltasFor(hand(winner, loser, pot))));
    },
  };
}

describe('the top fifty', () => {
  it('ranks by the metric asked for', async () => {
    const h = harness();
    await h.play(1, 2, 400);
    await h.play(3, 2, 100);

    const board = await h.service.leaderboard('net', 'alltime', null);

    expect(board.entries.map((entry) => entry.userId)).toEqual([user(1), user(3), user(2)]);
    expect(board.entries[0]?.rank).toBe(1);
    expect(board.entries[0]?.value).toBe(200);
  });

  it('carries every metric on each row, so the other columns need no second call', async () => {
    const h = harness();
    await h.play(1, 2, 400);

    const board = await h.service.leaderboard('net', 'alltime', null);
    const top = board.entries[0];

    expect(top?.stats.handsPlayed).toBe(1);
    expect(top?.stats.biggestPot).toBe(400);
    expect(top?.stats.bigBlind).toBe(10);
  });

  it('names the period key it was read from', async () => {
    const h = harness();
    await h.play(1, 2);

    expect((await h.service.leaderboard('net', 'month', null)).periodKey).toBe('2026-09');
    expect((await h.service.leaderboard('net', 'week', null)).periodKey).toBe('2026-W37');
  });
});

describe('the thirty-second cache', () => {
  it('reuses an answer inside the window', async () => {
    const h = harness();
    await h.play(1, 2);

    const first = await h.service.leaderboard('net', 'alltime', null);
    await h.play(3, 2, 1000);
    h.tick(LEADERBOARD_CACHE_MS - 1);

    const second = await h.service.leaderboard('net', 'alltime', null);
    expect(second.entries).toEqual(first.entries);
  });

  it('recomputes once the window is past', async () => {
    const h = harness();
    await h.play(1, 2);

    await h.service.leaderboard('net', 'alltime', null);
    await h.play(3, 2, 1000);
    h.tick(LEADERBOARD_CACHE_MS);

    const fresh = await h.service.leaderboard('net', 'alltime', null);
    expect(fresh.entries[0]?.userId).toBe(user(3));
  });

  it('caches each metric and period separately', async () => {
    const h = harness();
    await h.play(1, 2, 400);

    const byNet = await h.service.leaderboard('net', 'alltime', null);
    const byPot = await h.service.leaderboard('biggestPot', 'alltime', null);

    expect(byNet.metric).toBe('net');
    expect(byPot.metric).toBe('biggestPot');
    expect(byPot.entries[0]?.value).toBe(400);
  });
});

describe('the row a viewer is shown of themselves', () => {
  it('comes back even when they are nowhere near the top', async () => {
    const h = harness();
    // Everybody beats player 99.
    for (let n = 1; n <= 3; n += 1) await h.play(n, 99, 200);

    const board = await h.service.leaderboard('net', 'alltime', user(99));

    expect(board.viewer?.userId).toBe(user(99));
    expect(board.viewer?.rank).toBe(4);
    expect(board.viewer?.value).toBe(-300);
  });

  it('is the same object as the board row when they are on the board', async () => {
    const h = harness();
    await h.play(1, 2);

    const board = await h.service.leaderboard('net', 'alltime', user(1));
    expect(board.viewer).toEqual(board.entries[0]);
  });

  it('is null for somebody who has never finished a hand', async () => {
    const h = harness();
    await h.play(1, 2);

    const board = await h.service.leaderboard('net', 'alltime', user(42));
    expect(board.viewer).toBeNull();
  });
});

describe('the two-hundred hand threshold, as a reader sees it', () => {
  it('gives an unqualified viewer a count instead of a rank', async () => {
    const h = harness();
    for (let played = 0; played < 5; played += 1) await h.play(1, 2);

    const board = await h.service.leaderboard('winRate', 'alltime', user(1));

    expect(board.viewer?.rank).toBeNull();
    expect(board.viewer?.qualified).toBe(false);
    expect(board.viewer?.handsToQualify).toBe(MIN_RANKED_HANDS - 5);
  });

  it('gives them a rank on a total, which has no threshold', async () => {
    const h = harness();
    for (let played = 0; played < 5; played += 1) await h.play(1, 2);

    const board = await h.service.leaderboard('net', 'alltime', user(1));

    expect(board.viewer?.qualified).toBe(true);
    expect(board.viewer?.rank).toBe(1);
    expect(board.viewer?.handsToQualify).toBe(MIN_RANKED_HANDS - 5);
  });
});

describe('when the index cannot be reached', () => {
  it('answers from the record and says that it did', async () => {
    const h = harness();
    await h.play(1, 2, 400);

    const broken = createStatsService({
      store: h.store,
      index: {
        ...h.index,
        top: () => Promise.reject(new Error('redis is not there')),
        rank: () => Promise.reject(new Error('redis is not there')),
      },
      now: () => START,
    });

    const board = await broken.leaderboard('net', 'alltime', user(1));

    expect(board.degraded).toBe(true);
    expect(board.entries[0]?.userId).toBe(user(1));
    expect(board.entries[0]?.value).toBe(200);
    expect(board.viewer?.rank).toBe(1);
  });
});

describe('one player page', () => {
  it('carries the card, the ranks and the recent hands', async () => {
    const h = harness();
    await h.play(1, 2, 400);
    await h.play(1, 2, 100);

    const profile = await h.service.player(user(1));

    expect(profile?.stats.handsPlayed).toBe(2);
    expect(profile?.stats.netChips).toBe(250);
    expect(profile?.stats.biggestPot).toBe(400);
    expect(profile?.ranks.net).toBe(1);
    // A rate metric with two hands behind it ranks nobody.
    expect(profile?.ranks.winRate).toBeNull();
  });

  it('is null for an id nobody has ever been', async () => {
    const h = harness();
    const store = createMemoryStatsStore();
    const service = createStatsService({ store, index: h.index, now: () => START });

    expect(await service.player(user(77))).toBeNull();
  });
});
