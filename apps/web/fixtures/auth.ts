import type { OtpRequestResponse, PublicUser, SessionResponse, UserResponse } from '@poker/shared';
import { AuthRequestError } from '../lib/auth/api';
import { FIXTURE_VIEWER_USER_ID } from './scripted-hand';

/**
 * Sign-in with nothing behind it.
 *
 * The point is to walk the whole flow — phone, six boxes, resend countdown,
 * profile, lobby — without Postgres, Redis or an SMS account. The code is fixed
 * and the screen says what it is; a wrong one is refused with the same
 * `INVALID_INPUT` the real server sends, so the error states are reviewable too.
 */
export const FIXTURE_OTP_CODE = '424242';

const REQUEST_ID = '3f6d5c88-0000-4000-8000-0000000000aa';

let phoneOnRecord = '+15550000000';
let profile: { displayName: string; email: string | null; avatarSeed: string } = {
  displayName: '',
  email: null,
  avatarSeed: 'ace-of-spades',
};

/** A fixed instant, so a rebuild does not change what the screens show. */
const CREATED_AT = '2026-09-01T18:00:00.000Z';

function user(): PublicUser {
  return {
    id: FIXTURE_VIEWER_USER_ID,
    phone: phoneOnRecord,
    phoneVerified: true,
    email: profile.email,
    emailVerified: false,
    displayName: profile.displayName,
    avatarSeed: profile.avatarSeed,
    profileComplete: profile.displayName !== '',
    createdAt: CREATED_AT,
    lastSeenAt: CREATED_AT,
  };
}

/** Long enough to see the boxes fill, short enough not to wait for a demo. */
const LATENCY_MS = 350;

function afterLatency<T>(value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), LATENCY_MS));
}

export const fixtureAuth = {
  requestOtp(phone: string): Promise<OtpRequestResponse> {
    phoneOnRecord = normalise(phone);
    return afterLatency({ requestId: REQUEST_ID, expiresInSec: 300 });
  },

  async verifyOtp(requestId: string, code: string): Promise<SessionResponse> {
    await afterLatency(null);

    if (requestId !== REQUEST_ID) {
      throw new AuthRequestError({ code: 'INVALID_INPUT', message: 'that request has expired' });
    }
    if (code !== FIXTURE_OTP_CODE) {
      throw new AuthRequestError({
        code: 'INVALID_INPUT',
        message: `that code is not right — the fixture code is ${FIXTURE_OTP_CODE}`,
      });
    }

    return {
      accessToken: 'fixture-access-token',
      expiresInSec: 900,
      user: user(),
      isNewUser: profile.displayName === '',
    };
  },

  async saveProfile(body: {
    displayName: string;
    email?: string;
    avatarSeed: string;
  }): Promise<UserResponse> {
    await afterLatency(null);
    profile = {
      displayName: body.displayName,
      email: body.email ?? null,
      avatarSeed: body.avatarSeed,
    };
    return { user: user() };
  },
};

/**
 * The real server normalises with libphonenumber; the fixture only needs
 * something E.164-shaped so the profile screen has a number to show.
 */
function normalise(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  return `+${digits === '' ? '15550000000' : digits}`;
}
