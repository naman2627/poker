/**
 * The numbers behind the login flow, in one place.
 *
 * These are rules, not deployment knobs, so they live in code where they can be
 * read next to the logic they govern rather than in an env file where a typo
 * quietly widens a rate limit.
 */
export const OTP_CODE_DIGITS = 6;

/** How long a requested code stays usable. */
export const OTP_TTL_SEC = 5 * 60;

/** Wrong codes allowed per request before the request is burned. */
export const OTP_MAX_ATTEMPTS = 5;

export const RATE_LIMITS = {
  /** Codes one phone number may request in an hour. */
  phonePerHour: { limit: 3, windowSec: 60 * 60 },
  /** Codes one phone number may request in a day. */
  phonePerDay: { limit: 10, windowSec: 24 * 60 * 60 },
  /** Codes one IP address may request in a day, across every phone. */
  ipPerDay: { limit: 30, windowSec: 24 * 60 * 60 },
} as const;

export const ACCESS_TOKEN_TTL_SEC = 15 * 60;
export const REFRESH_TOKEN_TTL_SEC = 30 * 24 * 60 * 60;

export const REFRESH_COOKIE_NAME = 'poker_refresh';
/** The cookie is only ever sent to the endpoints that rotate or clear it. */
export const REFRESH_COOKIE_PATH = '/auth';

/** How the refresh cookie is scoped. Built by `cookiePolicyFor`, never by hand. */
export interface CookiePolicy {
  readonly secure: boolean;
  readonly sameSite: 'lax' | 'none';
}

/**
 * The site and the game server are allowed to be on different domains — the web
 * client on Vercel and the server on Render, say — and a cross-site fetch only
 * carries a cookie marked SameSite=None. With Lax the browser silently drops it
 * on the way to /auth/refresh, which does not fail loudly: signing in appears to
 * work and then every session ends at the first page reload.
 *
 * None requires Secure, which costs nothing, because anything that is not local
 * development is served over HTTPS. Development is plain http on localhost,
 * where Secure is impossible and same-origin makes Lax sufficient anyway.
 */
export function cookiePolicyFor(nodeEnv: 'development' | 'test' | 'production'): CookiePolicy {
  if (nodeEnv === 'development') return { secure: false, sameSite: 'lax' };
  return { secure: true, sameSite: 'none' };
}

export const otpKey = (requestId: string): string => `otp:${requestId}`;
export const otpAttemptsKey = (requestId: string): string => `otp:${requestId}:attempts`;
export const phoneHourKey = (phone: string): string => `rl:otp:phone:1h:${phone}`;
export const phoneDayKey = (phone: string): string => `rl:otp:phone:1d:${phone}`;
export const ipDayKey = (ip: string): string => `rl:otp:ip:1d:${ip}`;
