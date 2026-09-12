/**
 * `/leaderboard` and `/players/:id`, through the real routes.
 *
 * Driven with `app.inject()` against in-memory dependencies, so these assert
 * what a signed-in client actually receives — including the two things that are
 * easy to get right in a unit test and wrong at the edge: the auth requirement,
 * and the shape the schema promises.
 */
import { describe, expect, it } from 'vitest';
import {
  LeaderboardResponseSchema,
  MIN_RANKED_HANDS,
  PlayerProfileResponseSchema,
} from '@poker/shared';
import type { HandEnded } from '../src/history/records';
import { deltasFor } from '../src/stats/delta';
import { bearer, createTestApp, login, type TestApp } from './support';

const AT = new Date('2026-09-12T12:00:00Z');
const OTHER = '00000000-0000-4000-8000-0000000000aa';

function hand(winner: string, loser: string, pot = 200): HandEnded {
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
        userId: winner,
        seatIndex: 0,
        holeCards: [],
        shown: true,
        shownCategory: 'FLUSH',
        endingStack: 1000,
        net: pot / 2,
        wagered: pot / 2,
        potWon: pot,
        wentToShowdown: true,
        won: true,
      },
      {
        userId: loser,
        seatIndex: 1,
        holeCards: [],
        shown: false,
        shownCategory: null,
        endingStack: 1000,
        net: -pot / 2,
        wagered: pot / 2,
        potWon: 0,
        wentToShowdown: true,
        won: false,
      },
    ],
  };
}

async function count(app: TestApp, record: HandEnded): Promise<void> {
  const store = app.stats;
  const index = app.index;
  if (store === null || index === null) throw new Error('this app was built without statistics');
  await index.mirror(await store.applyHand(deltasFor(record)));
}

describe('GET /leaderboard', () => {
  it('needs an access token', async () => {
    const app = await createTestApp({ withStats: true });
    try {
      const response = await app.app.inject({ method: 'GET', url: '/leaderboard' });
      expect(response.statusCode).toBe(401);
      expect(response.json<{ code: string }>().code).toBe('UNAUTHENTICATED');
    } finally {
      await app.close();
    }
  });

  it('answers the all-time net board by default', async () => {
    const names = new Map<string, string>();
    const app = await createTestApp({ withStats: true, displayNames: names });

    try {
      const me = await login(app);
      names.set(me.userId, 'Ada');
      names.set(OTHER, 'Bo');
      await count(app, hand(me.userId, OTHER));

      const response = await app.app.inject({
        method: 'GET',
        url: '/leaderboard',
        headers: bearer(me.accessToken),
      });

      expect(response.statusCode).toBe(200);
      const board = LeaderboardResponseSchema.parse(response.json());

      expect(board.metric).toBe('net');
      expect(board.period).toBe('alltime');
      expect(board.periodKey).toBe('alltime');
      expect(board.entries[0]?.displayName).toBe('Ada');
      expect(board.entries[0]?.value).toBe(100);
      expect(board.entries[0]?.rank).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('pins a row for the viewer even when they are last', async () => {
    const names = new Map<string, string>();
    const app = await createTestApp({ withStats: true, displayNames: names });

    try {
      const me = await login(app);
      names.set(me.userId, 'Ada');
      await count(app, hand(OTHER, me.userId));

      const response = await app.app.inject({
        method: 'GET',
        url: '/leaderboard',
        headers: bearer(me.accessToken),
      });

      const board = LeaderboardResponseSchema.parse(response.json());
      expect(board.viewer?.userId).toBe(me.userId);
      expect(board.viewer?.rank).toBe(2);
      expect(board.viewer?.value).toBe(-100);
    } finally {
      await app.close();
    }
  });

  it('reads the metric and the period off the query', async () => {
    const app = await createTestApp({ withStats: true });

    try {
      const me = await login(app);
      await count(app, hand(me.userId, OTHER));

      const response = await app.app.inject({
        method: 'GET',
        url: '/leaderboard?metric=biggestPot&period=week',
        headers: bearer(me.accessToken),
      });

      const board = LeaderboardResponseSchema.parse(response.json());
      expect(board.metric).toBe('biggestPot');
      expect(board.period).toBe('week');
      expect(board.periodKey).toMatch(/^\d{4}-W\d{2}$/);
    } finally {
      await app.close();
    }
  });

  it('refuses a metric this server does not keep', async () => {
    const app = await createTestApp({ withStats: true });

    try {
      const me = await login(app);
      const response = await app.app.inject({
        method: 'GET',
        url: '/leaderboard?metric=luck',
        headers: bearer(me.accessToken),
      });

      expect(response.statusCode).toBe(400);
      expect(response.json<{ code: string }>().code).toBe('INVALID_INPUT');
    } finally {
      await app.close();
    }
  });

  it('tells an unqualified viewer how many hands are left rather than a rank', async () => {
    const app = await createTestApp({ withStats: true });

    try {
      const me = await login(app);
      await count(app, hand(me.userId, OTHER));

      const response = await app.app.inject({
        method: 'GET',
        url: '/leaderboard?metric=bb100',
        headers: bearer(me.accessToken),
      });

      const board = LeaderboardResponseSchema.parse(response.json());
      expect(board.viewer?.qualified).toBe(false);
      expect(board.viewer?.rank).toBeNull();
      expect(board.viewer?.handsToQualify).toBe(MIN_RANKED_HANDS - 1);
      // And nobody is ranked on it yet, so the board itself is empty.
      expect(board.entries).toEqual([]);
    } finally {
      await app.close();
    }
  });
});

describe('GET /players/:id', () => {
  it('needs an access token', async () => {
    const app = await createTestApp({ withStats: true });
    try {
      const response = await app.app.inject({ method: 'GET', url: `/players/${OTHER}` });
      expect(response.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('refuses something that is not a player id', async () => {
    const app = await createTestApp({ withStats: true });
    try {
      const me = await login(app);
      const response = await app.app.inject({
        method: 'GET',
        url: '/players/not-a-uuid',
        headers: bearer(me.accessToken),
      });
      expect(response.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('carries the card and the all-time ranks', async () => {
    const names = new Map<string, string>();
    const app = await createTestApp({ withStats: true, displayNames: names });

    try {
      const me = await login(app);
      names.set(me.userId, 'Ada');
      await count(app, hand(me.userId, OTHER, 400));
      await count(app, hand(me.userId, OTHER, 100));

      const response = await app.app.inject({
        method: 'GET',
        url: `/players/${me.userId}`,
        headers: bearer(me.accessToken),
      });

      expect(response.statusCode).toBe(200);
      const profile = PlayerProfileResponseSchema.parse(response.json());

      expect(profile.displayName).toBe('Ada');
      expect(profile.stats.handsPlayed).toBe(2);
      expect(profile.stats.netChips).toBe(250);
      expect(profile.stats.biggestPot).toBe(400);
      expect(profile.stats.bestHandCategory).toBe('FLUSH');
      expect(profile.ranks.net).toBe(1);
      // Two hands is not a rate.
      expect(profile.ranks.bb100).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('is a 404 for an id that has never played and has no account', async () => {
    const app = await createTestApp({ withStats: true });
    try {
      const me = await login(app);
      const response = await app.app.inject({
        method: 'GET',
        url: `/players/${OTHER}`,
        headers: bearer(me.accessToken),
      });

      expect(response.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
