/**
 * The login flow: requesting a code, verifying it, and every way that can go
 * wrong. Everything runs through the real routes against in-memory ports.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OTP_MAX_ATTEMPTS, OTP_TTL_SEC, otpKey } from '../src/auth/policy';
import {
  createTestApp,
  login,
  refreshCookieAttributes,
  refreshCookieOf,
  type TestApp,
} from './support';

const PHONE = '+14155552671';
const MINUTE = 60_000;

describe('POST /auth/otp/request', () => {
  let harness: TestApp;

  beforeEach(async () => {
    harness = await createTestApp();
  });

  afterEach(async () => {
    await harness.close();
  });

  it('sends a six-digit code and answers with a request id', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/auth/otp/request',
      payload: { phone: PHONE },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      expiresInSec: OTP_TTL_SEC,
    });
    expect(harness.auth.sms.sent).toHaveLength(1);
    expect(harness.auth.sms.last().code).toMatch(/^\d{6}$/);
  });

  it('normalises the number to E.164 before anything else sees it', async () => {
    await harness.app.inject({
      method: 'POST',
      url: '/auth/otp/request',
      payload: { phone: '+1 (415) 555-2671' },
    });

    expect(harness.auth.sms.last().phone).toBe(PHONE);
  });

  it('refuses a number it cannot parse', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/auth/otp/request',
      payload: { phone: '12345' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'INVALID_INPUT' });
    expect(harness.auth.sms.sent).toHaveLength(0);
  });

  it('never puts the plaintext code in the store', async () => {
    await harness.app.inject({
      method: 'POST',
      url: '/auth/otp/request',
      payload: { phone: PHONE },
    });

    const code = harness.auth.sms.last().code;
    const stored = harness.auth.kv.entries().map(([, value]) => value);

    expect(stored.join('|')).not.toContain(code);
    expect(stored.join('|')).toContain('$argon2id$');
  });

  it('does not answer with the code, however hard the response is read', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/auth/otp/request',
      payload: { phone: PHONE },
    });

    expect(response.body).not.toContain(harness.auth.sms.last().code);
  });
});

describe('POST /auth/otp/verify', () => {
  let harness: TestApp;

  beforeEach(async () => {
    harness = await createTestApp();
  });

  afterEach(async () => {
    await harness.close();
  });

  /** Request a code and hand back the id and the code that was "sent". */
  async function requestCode(phone = PHONE): Promise<{ requestId: string; code: string }> {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/auth/otp/request',
      payload: { phone },
    });
    return {
      requestId: response.json<{ requestId: string }>().requestId,
      code: harness.auth.sms.last().code,
    };
  }

  it('creates the account the first time a number is seen', async () => {
    const { requestId, code } = await requestCode();

    const response = await harness.app.inject({
      method: 'POST',
      url: '/auth/otp/verify',
      payload: { requestId, code },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{
      accessToken: string;
      isNewUser: boolean;
      user: {
        phone: string;
        phoneVerified: boolean;
        displayName: string;
        profileComplete: boolean;
      };
    }>();

    expect(body.isNewUser).toBe(true);
    expect(body.accessToken.split('.')).toHaveLength(3);
    expect(body.user.phone).toBe(PHONE);
    expect(body.user.phoneVerified).toBe(true);
    // No name yet: the client has to go through /auth/profile before it plays.
    expect(body.user.displayName).toBe('');
    expect(body.user.profileComplete).toBe(false);
  });

  it('sets the refresh cookie httpOnly, secure, lax and scoped to /auth', async () => {
    const { requestId, code } = await requestCode();

    const response = await harness.app.inject({
      method: 'POST',
      url: '/auth/otp/verify',
      payload: { requestId, code },
    });

    expect(refreshCookieOf(response)).toBeTruthy();
    // SameSite=None because the site and the server are on different domains
    // in every deployment of this — see `cookiePolicyFor`.
    expect(refreshCookieAttributes(response)).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: 'None',
      path: '/auth',
    });
  });

  it('returns the same account, not a new one, the second time', async () => {
    const first = await login(harness);
    const second = await login(harness);

    expect(first.isNewUser).toBe(true);
    expect(second.isNewUser).toBe(false);
    expect(second.userId).toBe(first.userId);
  });

  it('rejects the wrong code and keeps the request alive for another try', async () => {
    const { requestId, code } = await requestCode();

    const wrong = await harness.app.inject({
      method: 'POST',
      url: '/auth/otp/verify',
      payload: { requestId, code: nudge(code) },
    });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json()).toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(refreshCookieOf(wrong)).toBeNull();

    const right = await harness.app.inject({
      method: 'POST',
      url: '/auth/otp/verify',
      payload: { requestId, code },
    });
    expect(right.statusCode).toBe(200);
  });

  it('rejects a code that has passed its five minutes', async () => {
    const { requestId, code } = await requestCode();

    harness.auth.clock.advance(OTP_TTL_SEC * 1000 + 1);

    const response = await harness.app.inject({
      method: 'POST',
      url: '/auth/otp/verify',
      payload: { requestId, code },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json<{ message: string }>().message).toMatch(/expired/);
  });

  it('still works one second before it expires', async () => {
    const { requestId, code } = await requestCode();

    harness.auth.clock.advance(OTP_TTL_SEC * 1000 - 1_000);

    const response = await harness.app.inject({
      method: 'POST',
      url: '/auth/otp/verify',
      payload: { requestId, code },
    });

    expect(response.statusCode).toBe(200);
  });

  it('burns the request after five wrong codes', async () => {
    const { requestId, code } = await requestCode();

    for (let attempt = 1; attempt <= OTP_MAX_ATTEMPTS; attempt += 1) {
      const response = await harness.app.inject({
        method: 'POST',
        url: '/auth/otp/verify',
        payload: { requestId, code: nudge(code) },
      });
      expect(response.statusCode).toBe(401);
      expect(response.json<{ message: string }>().message).toMatch(/not right/);
    }

    // The record is gone, so even the right code is no good now.
    const afterBurn = await harness.app.inject({
      method: 'POST',
      url: '/auth/otp/verify',
      payload: { requestId, code },
    });

    expect(afterBurn.statusCode).toBe(401);
    expect(afterBurn.json<{ message: string }>().message).toMatch(/expired/);
    expect(harness.auth.kv.entries().map(([key]) => key)).not.toContain(otpKey(requestId));
  });

  it('cannot be replayed: a verified code is spent', async () => {
    const { requestId, code } = await requestCode();

    const first = await harness.app.inject({
      method: 'POST',
      url: '/auth/otp/verify',
      payload: { requestId, code },
    });
    const replay = await harness.app.inject({
      method: 'POST',
      url: '/auth/otp/verify',
      payload: { requestId, code },
    });

    expect(first.statusCode).toBe(200);
    expect(replay.statusCode).toBe(401);
  });

  it('refuses a request id that was never issued', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/auth/otp/verify',
      payload: { requestId: '11111111-2222-4333-8444-555555555555', code: '123456' },
    });

    expect(response.statusCode).toBe(401);
  });

  it('refuses a code that is not six digits without touching the store', async () => {
    const { requestId } = await requestCode();

    const response = await harness.app.inject({
      method: 'POST',
      url: '/auth/otp/verify',
      payload: { requestId, code: '12ab' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'INVALID_INPUT' });
  });
});

describe('rate limits', () => {
  let harness: TestApp;

  beforeEach(async () => {
    harness = await createTestApp();
  });

  afterEach(async () => {
    await harness.close();
  });

  const requestFor = (phone: string, ip = '203.0.113.5') =>
    harness.app.inject({
      method: 'POST',
      url: '/auth/otp/request',
      payload: { phone },
      remoteAddress: ip,
    });

  it('allows three codes an hour for one number and refuses the fourth', async () => {
    for (let i = 0; i < 3; i += 1) {
      expect((await requestFor(PHONE)).statusCode).toBe(200);
    }

    const blocked = await requestFor(PHONE);

    expect(blocked.statusCode).toBe(429);
    const body = blocked.json<{ code: string; message: string; retryAfter: number }>();
    expect(body.code).toBe('RATE_LIMITED');
    expect(body.retryAfter).toBeGreaterThan(0);
    expect(body.retryAfter).toBeLessThanOrEqual(60 * 60);
    expect(blocked.headers['retry-after']).toBe(String(body.retryAfter));
    expect(harness.auth.sms.sent).toHaveLength(3);
  });

  it('lets the same number back in once the hour has passed', async () => {
    for (let i = 0; i < 3; i += 1) await requestFor(PHONE);
    expect((await requestFor(PHONE)).statusCode).toBe(429);

    harness.auth.clock.advance(60 * MINUTE + 1_000);

    expect((await requestFor(PHONE)).statusCode).toBe(200);
  });

  it('stops one number at ten codes a day, however patient the caller is', async () => {
    let accepted = 0;
    // Ten hourly windows, three codes each: the daily limit bites first.
    for (let hour = 0; hour < 10; hour += 1) {
      for (let i = 0; i < 3; i += 1) {
        if ((await requestFor(PHONE)).statusCode === 200) accepted += 1;
      }
      harness.auth.clock.advance(60 * MINUTE + 1_000);
    }

    expect(accepted).toBe(10);
    const blocked = await requestFor(PHONE);
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json<{ message: string }>().message).toMatch(/in a day/);
  });

  it('stops one address at thirty codes a day across every number it tries', async () => {
    let accepted = 0;
    // A fresh number each time, so only the address limit can stop it.
    for (let attempt = 0; attempt < 31; attempt += 1) {
      const phone = `+1415555${String(3000 + attempt).padStart(4, '0')}`;
      const response = await requestFor(phone, '198.51.100.9');
      if (response.statusCode === 200) accepted += 1;
      if (attempt === 30) {
        expect(response.statusCode).toBe(429);
        expect(response.json<{ message: string }>().message).toMatch(/this device/);
      }
    }

    expect(accepted).toBe(30);
  });

  it('counts addresses separately', async () => {
    for (let i = 0; i < 3; i += 1) await requestFor(PHONE, '203.0.113.5');
    expect((await requestFor(PHONE, '203.0.113.5')).statusCode).toBe(429);

    // A different number from a different address is unaffected.
    const other = await requestFor('+14155559988', '203.0.113.77');
    expect(other.statusCode).toBe(200);
  });
});

/** The same code with one digit changed — always wrong, never malformed. */
function nudge(code: string): string {
  const first = code[0] ?? '0';
  const shifted = String((Number(first) + 1) % 10);
  return `${shifted}${code.slice(1)}`;
}
