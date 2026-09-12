import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import argon2 from 'argon2';
import { OTP_CODE_DIGITS } from './policy';

/**
 * The two kinds of secret this service handles, and why they are hashed
 * differently.
 *
 * An OTP has about twenty bits of entropy, so a leaked store must be expensive
 * to attack: argon2id, verified through the library's own constant-time check.
 *
 * A refresh token is 256 bits of randomness, so brute force is not the threat —
 * being able to look one up is. It gets a keyed HMAC-SHA256: fast enough to
 * index on, and useless to anyone who steals the table without the pepper.
 */

/** A zero-padded numeric code, from the CSPRNG. Never logged, never stored. */
export function generateOtpCode(): string {
  const max = 10 ** OTP_CODE_DIGITS;
  return String(randomInt(0, max)).padStart(OTP_CODE_DIGITS, '0');
}

export function hashOtpCode(code: string): Promise<string> {
  return argon2.hash(code, { type: argon2.argon2id });
}

/** Constant-time by construction: argon2's own verify does the comparison. */
export async function verifyOtpCode(hash: string, code: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, code);
  } catch {
    // A malformed hash is a corrupt record, not a valid code.
    return false;
  }
}

/** 256 bits, base64url, for the refresh cookie. */
export function generateRefreshToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashRefreshToken(token: string, pepper: string): string {
  return createHmac('sha256', pepper).update(token).digest('hex');
}

/** Compares two hex digests without leaking where they first differ. */
export function digestsMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
