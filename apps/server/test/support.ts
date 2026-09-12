/** Driving the real routes with in-memory dependencies. */
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/app';
import { REFRESH_COOKIE_NAME } from '../src/auth/policy';
import { loadConfig } from '../src/config';
import { createMemoryLeaderboardIndex } from '../src/stats/memory-index';
import { createMemoryStatsStore } from '../src/stats/memory-store';
import type { LeaderboardIndex, StatsStore } from '../src/stats/ports';
import { createStatsService } from '../src/stats/service';
import { createTestAuth, type TestAuth } from './fakes';

export interface TestApp {
  readonly app: FastifyInstance;
  readonly auth: TestAuth;
  /** Present only when the app was built with the statistics routes. */
  readonly stats: StatsStore | null;
  readonly index: LeaderboardIndex | null;
  close(): Promise<void>;
}

export interface TestAppOptions {
  /**
   * Wire the leaderboards in. Off by default so the auth tests build the
   * smallest app that answers their questions, exactly as they did before.
   */
  readonly withStats?: boolean;
  /** Names for the board, since there is no `users` table to join to here. */
  readonly displayNames?: ReadonlyMap<string, string>;
}

export async function createTestApp(options: TestAppOptions = {}): Promise<TestApp> {
  const auth = createTestAuth();

  const stats =
    options.withStats === true
      ? createMemoryStatsStore({
          profileFor: (userId) => {
            const displayName = options.displayNames?.get(userId);
            return displayName === undefined ? null : { displayName, avatarSeed: null };
          },
        })
      : null;
  const index = options.withStats === true ? createMemoryLeaderboardIndex() : null;

  const app = await buildApp(
    loadConfig({ NODE_ENV: 'test' }),
    auth,
    undefined,
    stats !== null && index !== null ? createStatsService({ store: stats, index }) : undefined,
  );
  await app.ready();

  return {
    app,
    auth,
    stats,
    index,
    close: async (): Promise<void> => {
      await app.close();
      await auth.close();
    },
  };
}

export const bearer = (accessToken: string): Record<string, string> => ({
  authorization: `Bearer ${accessToken}`,
});

export const withCookie = (refreshToken: string): Record<string, string> => ({
  cookie: `${REFRESH_COOKIE_NAME}=${refreshToken}`,
});

/** The refresh cookie a response set, or null if it set none. */
export function refreshCookieOf(response: LightMyRequestResponse): string | null {
  const cookie = response.cookies.find((entry) => entry.name === REFRESH_COOKIE_NAME);
  return cookie && cookie.value !== '' ? cookie.value : null;
}

export function refreshCookieAttributes(
  response: LightMyRequestResponse,
): Record<string, unknown> | null {
  return response.cookies.find((entry) => entry.name === REFRESH_COOKIE_NAME) ?? null;
}

export interface LoggedIn {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly userId: string;
  readonly isNewUser: boolean;
}

/** Request a code, read it off the fake gateway, and verify it. */
export async function login(
  { app, auth }: TestApp,
  phone = '+14155552671',
  options: InjectOptions = {},
): Promise<LoggedIn> {
  const requested = await app.inject({
    method: 'POST',
    url: '/auth/otp/request',
    payload: { phone },
    ...options,
  });
  const { requestId } = requested.json<{ requestId: string }>();

  const verified = await app.inject({
    method: 'POST',
    url: '/auth/otp/verify',
    payload: { requestId, code: auth.sms.last().code },
  });

  const body = verified.json<{
    accessToken: string;
    isNewUser: boolean;
    user: { id: string };
  }>();
  const refreshToken = refreshCookieOf(verified);
  if (refreshToken === null) throw new Error('login did not set a refresh cookie');

  return {
    accessToken: body.accessToken,
    refreshToken,
    userId: body.user.id,
    isNewUser: body.isNewUser,
  };
}
