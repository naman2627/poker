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

export const otpKey = (requestId: string): string => `otp:${requestId}`;
export const otpAttemptsKey = (requestId: string): string => `otp:${requestId}:attempts`;
export const phoneHourKey = (phone: string): string => `rl:otp:phone:1h:${phone}`;
export const phoneDayKey = (phone: string): string => `rl:otp:phone:1d:${phone}`;
export const ipDayKey = (ip: string): string => `rl:otp:ip:1d:${ip}`;
