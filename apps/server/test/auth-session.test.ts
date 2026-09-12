/**
 * What happens after the code is right: the access token, the profile the
 * client must fill in, and the refresh token rotating under it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ACCESS_TOKEN_TTL_SEC, REFRESH_TOKEN_TTL_SEC } from '../src/auth/policy';
import { bearer, createTestApp, login, refreshCookieOf, withCookie, type TestApp } from './support';

describe('GET /auth/me', () => {
  let harness: TestApp;

  beforeEach(async () => {
    harness = await createTestApp();
  });

  afterEach(async () => {
    await harness.close();
  });

  it('answers with the account behind the access token', async () => {
    const session = await login(harness);

    const response = await harness.app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: bearer(session.accessToken),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ user: { id: string } }>().user.id).toBe(session.userId);
  });

  it('refuses a request with no token, a junk token, or the wrong scheme', async () => {
    const session = await login(harness);

    for (const headers of [
      {},
      bearer('not-a-jwt'),
      { authorization: `Basic ${session.accessToken}` },
    ]) {
      const response = await harness.app.inject({ method: 'GET', url: '/auth/me', headers });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ code: 'UNAUTHENTICATED' });
    }
  });

  it('refuses an access token once its fifteen minutes are up', async () => {
    const session = await login(harness);

    harness.auth.clock.advance(ACCESS_TOKEN_TTL_SEC * 1000 + 1_000);

    const response = await harness.app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: bearer(session.accessToken),
    });

    expect(response.statusCode).toBe(401);
  });
});

describe('POST /auth/profile', () => {
  let harness: TestApp;

  beforeEach(async () => {
    harness = await createTestApp();
  });

  afterEach(async () => {
    await harness.close();
  });

  it('completes the profile a new account is missing', async () => {
    const session = await login(harness);

    const response = await harness.app.inject({
      method: 'POST',
      url: '/auth/profile',
      headers: bearer(session.accessToken),
      payload: { displayName: 'Rounder', email: 'rounder@example.com' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ user: unknown }>().user).toMatchObject({
      displayName: 'Rounder',
      email: 'rounder@example.com',
      emailVerified: false,
      profileComplete: true,
    });
  });

  it('is happy without an email, since only the phone is the identity', async () => {
    const session = await login(harness);

    const response = await harness.app.inject({
      method: 'POST',
      url: '/auth/profile',
      headers: bearer(session.accessToken),
      payload: { displayName: 'Anon' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ user: { email: null; profileComplete: boolean } }>().user).toMatchObject(
      {
        email: null,
        profileComplete: true,
      },
    );
  });

  it('refuses an email that is already on another account', async () => {
    const first = await login(harness, '+14155552671');
    await harness.app.inject({
      method: 'POST',
      url: '/auth/profile',
      headers: bearer(first.accessToken),
      payload: { displayName: 'First', email: 'shared@example.com' },
    });

    const second = await login(harness, '+14155559999');
    const response = await harness.app.inject({
      method: 'POST',
      url: '/auth/profile',
      headers: bearer(second.accessToken),
      payload: { displayName: 'Second', email: 'shared@example.com' },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: 'CONFLICT' });
  });

  it('rejects a name too short to show at a table, and a bad email', async () => {
    const session = await login(harness);

    for (const payload of [
      { displayName: 'x' },
      { displayName: 'Rounder', email: 'not-an-email' },
      {},
    ]) {
      const response = await harness.app.inject({
        method: 'POST',
        url: '/auth/profile',
        headers: bearer(session.accessToken),
        payload,
      });
      expect(response.statusCode).toBe(400);
    }
  });

  it('needs an access token like everything else behind the login', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/auth/profile',
      payload: { displayName: 'Nobody' },
    });

    expect(response.statusCode).toBe(401);
  });
});

describe('POST /auth/refresh', () => {
  let harness: TestApp;

  beforeEach(async () => {
    harness = await createTestApp();
  });

  afterEach(async () => {
    await harness.close();
  });

  const refreshWith = (token: string) =>
    harness.app.inject({ method: 'POST', url: '/auth/refresh', headers: withCookie(token) });

  it('hands back a new access token and a new refresh cookie', async () => {
    const session = await login(harness);

    // Move the clock so the new JWT cannot be byte-identical to the old one.
    harness.auth.clock.advance(2_000);
    const response = await refreshWith(session.refreshToken);

    expect(response.statusCode).toBe(200);
    const body = response.json<{ accessToken: string; user: { id: string } }>();
    expect(body.accessToken).not.toBe(session.accessToken);
    expect(body.user.id).toBe(session.userId);

    const rotated = refreshCookieOf(response);
    expect(rotated).toBeTruthy();
    expect(rotated).not.toBe(session.refreshToken);
  });

  it('keeps the rotated token inside the same family', async () => {
    const session = await login(harness);
    await refreshWith(session.refreshToken);

    const families = new Set(harness.auth.refreshTokens.all().map((row) => row.familyId));
    expect(harness.auth.refreshTokens.all()).toHaveLength(2);
    expect(families.size).toBe(1);
  });

  it('records what replaced the token it retired', async () => {
    const session = await login(harness);
    await refreshWith(session.refreshToken);

    const rows = harness.auth.refreshTokens.all();
    const retired = rows.find((row) => row.revokedAt !== null);
    const current = rows.find((row) => row.revokedAt === null);

    expect(retired?.replacedBy).toBe(current?.id);
  });

  it('lets the new token refresh again, and again', async () => {
    let token = (await login(harness)).refreshToken;

    for (let i = 0; i < 3; i += 1) {
      const response = await refreshWith(token);
      expect(response.statusCode).toBe(200);
      const next = refreshCookieOf(response);
      expect(next).toBeTruthy();
      token = next ?? token;
    }
  });

  it('refuses a request with no cookie at all', async () => {
    const response = await harness.app.inject({ method: 'POST', url: '/auth/refresh' });

    expect(response.statusCode).toBe(401);
  });

  it('refuses a token nobody ever issued', async () => {
    const response = await refreshWith('a-token-that-was-never-issued');

    expect(response.statusCode).toBe(401);
  });

  it('refuses a token that has passed its thirty days', async () => {
    const session = await login(harness);

    harness.auth.clock.advance(REFRESH_TOKEN_TTL_SEC * 1000 + 1_000);
    const response = await refreshWith(session.refreshToken);

    expect(response.statusCode).toBe(401);
    expect(response.json<{ message: string }>().message).toMatch(/expired/);
  });
});

describe('refresh token reuse', () => {
  let harness: TestApp;

  beforeEach(async () => {
    harness = await createTestApp();
  });

  afterEach(async () => {
    await harness.close();
  });

  const refreshWith = (token: string) =>
    harness.app.inject({ method: 'POST', url: '/auth/refresh', headers: withCookie(token) });

  it('refuses a token that has already been rotated away', async () => {
    const session = await login(harness);
    await refreshWith(session.refreshToken);

    const replay = await refreshWith(session.refreshToken);

    expect(replay.statusCode).toBe(401);
    expect(replay.json<{ message: string }>().message).toMatch(/already used elsewhere/);
  });

  it('kills the whole family, so the thief and the victim both start again', async () => {
    const session = await login(harness);
    const rotated = refreshCookieOf(await refreshWith(session.refreshToken));
    if (rotated === null) throw new Error('rotation did not set a cookie');

    // The stolen copy of the old token is presented...
    expect((await refreshWith(session.refreshToken)).statusCode).toBe(401);

    // ...and the token the real client is holding is dead too.
    const afterBreach = await refreshWith(rotated);
    expect(afterBreach.statusCode).toBe(401);
    expect(harness.auth.refreshTokens.all().every((row) => row.revokedAt !== null)).toBe(true);
  });

  it('clears the cookie when it refuses, so the browser stops presenting it', async () => {
    const session = await login(harness);
    await refreshWith(session.refreshToken);

    const replay = await refreshWith(session.refreshToken);

    expect(refreshCookieOf(replay)).toBeNull();
  });

  it('leaves other logins of the same account alone', async () => {
    const phone = '+14155552671';
    const first = await login(harness, phone);
    const second = await login(harness, phone);

    await refreshWith(first.refreshToken);
    expect((await refreshWith(first.refreshToken)).statusCode).toBe(401);

    // The second login is its own family: a breach in one does not sign out the
    // other device.
    expect((await refreshWith(second.refreshToken)).statusCode).toBe(200);
  });
});

describe('POST /auth/logout', () => {
  let harness: TestApp;

  beforeEach(async () => {
    harness = await createTestApp();
  });

  afterEach(async () => {
    await harness.close();
  });

  it('revokes the session and clears the cookie', async () => {
    const session = await login(harness);

    const response = await harness.app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: withCookie(session.refreshToken),
    });

    expect(response.statusCode).toBe(200);
    expect(refreshCookieOf(response)).toBeNull();

    const afterLogout = await harness.app.inject({
      method: 'POST',
      url: '/auth/refresh',
      headers: withCookie(session.refreshToken),
    });
    expect(afterLogout.statusCode).toBe(401);
  });

  it('is quiet about a cookie it does not recognise', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: withCookie('never-issued'),
    });

    expect(response.statusCode).toBe(200);
  });

  it('does not mind being called with nothing at all', async () => {
    const response = await harness.app.inject({ method: 'POST', url: '/auth/logout' });

    expect(response.statusCode).toBe(200);
  });
});
