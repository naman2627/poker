import { randomUUID } from 'node:crypto';
import type { SmsProvider } from '../sms/provider';
import { AuthError } from './errors';
import { normalizePhone } from './phone';
import {
  OTP_MAX_ATTEMPTS,
  OTP_TTL_SEC,
  RATE_LIMITS,
  ipDayKey,
  otpAttemptsKey,
  otpKey,
  phoneDayKey,
  phoneHourKey,
} from './policy';
import type { Clock, KeyValueStore, UserRecord, UserRepository } from './ports';
import { generateOtpCode, hashOtpCode, verifyOtpCode } from './secrets';

export interface OtpServiceDeps {
  readonly kv: KeyValueStore;
  readonly users: UserRepository;
  readonly sms: SmsProvider;
  readonly clock: Clock;
}

export interface OtpRequestResult {
  readonly requestId: string;
  readonly expiresInSec: number;
}

export interface OtpVerifyResult {
  readonly user: UserRecord;
  readonly isNewUser: boolean;
}

/** What Redis holds for a pending request. The code is only ever in `codeHash`. */
interface OtpRecord {
  readonly phone: string;
  readonly codeHash: string;
}

/**
 * Requesting and verifying a one-time code.
 *
 * The plaintext code exists in exactly two places: the argument handed to the
 * SMS provider, and the SMS itself. What Redis holds is an argon2 hash, and
 * nothing in this file logs the code or returns it to a caller.
 */
export class OtpService {
  readonly #kv: KeyValueStore;
  readonly #users: UserRepository;
  readonly #sms: SmsProvider;
  readonly #clock: Clock;

  constructor(deps: OtpServiceDeps) {
    this.#kv = deps.kv;
    this.#users = deps.users;
    this.#sms = deps.sms;
    this.#clock = deps.clock;
  }

  /**
   * Send a code to `phoneInput` on behalf of `ip`.
   *
   * The three rate limits are checked in order — this phone this hour, this
   * phone today, this address today — so the message names the limit that was
   * actually hit and `retryAfter` is that window's remaining time.
   */
  async request(phoneInput: string, ip: string): Promise<OtpRequestResult> {
    const phone = normalizePhone(phoneInput);

    await this.#consume(phoneHourKey(phone), RATE_LIMITS.phonePerHour, 'this number', 'an hour');
    await this.#consume(phoneDayKey(phone), RATE_LIMITS.phonePerDay, 'this number', 'a day');
    await this.#consume(ipDayKey(ip), RATE_LIMITS.ipPerDay, 'this device', 'a day');

    const requestId = randomUUID();
    const code = generateOtpCode();
    const record: OtpRecord = { phone, codeHash: await hashOtpCode(code) };

    await this.#kv.set(otpKey(requestId), JSON.stringify(record), OTP_TTL_SEC);
    await this.#sms.sendOtp({ phone, code, expiresInSec: OTP_TTL_SEC });

    return { requestId, expiresInSec: OTP_TTL_SEC };
  }

  /**
   * Check a code and, if it is right, hand back the account behind the number —
   * creating it on the spot the first time that number is seen.
   *
   * A request is single use: it is burned on success, on the fifth wrong code,
   * and by its own five-minute expiry.
   */
  async verify(requestId: string, code: string): Promise<OtpVerifyResult> {
    const raw = await this.#kv.get(otpKey(requestId));
    if (raw === null) {
      throw AuthError.unauthenticated('that code has expired — ask for a new one');
    }

    const attempt = await this.#kv.increment(otpAttemptsKey(requestId), OTP_TTL_SEC);
    if (attempt.count > OTP_MAX_ATTEMPTS) {
      await this.#burn(requestId);
      throw AuthError.unauthenticated('too many wrong codes — ask for a new one');
    }

    const record = parseRecord(raw);
    if (record === null) {
      await this.#burn(requestId);
      throw AuthError.unauthenticated('that code has expired — ask for a new one');
    }

    if (!(await verifyOtpCode(record.codeHash, code))) {
      // The last attempt takes the request with it, so a burned-through request
      // cannot be retried by asking again with the same id.
      if (attempt.count >= OTP_MAX_ATTEMPTS) await this.#burn(requestId);
      throw AuthError.unauthenticated('that code is not right');
    }

    await this.#burn(requestId);
    return this.#resolveUser(record.phone);
  }

  /** First sight of a number creates the account, with no profile on it yet. */
  async #resolveUser(phone: string): Promise<OtpVerifyResult> {
    const existing = await this.#users.findByPhone(phone);
    if (existing) {
      await this.#users.touchLastSeen(existing.id, new Date(this.#clock.now()));
      const refreshed = await this.#users.findById(existing.id);
      return { user: refreshed ?? existing, isNewUser: false };
    }

    const created = await this.#users.create({ phone, avatarSeed: randomUUID() });
    return { user: created, isNewUser: true };
  }

  async #consume(
    key: string,
    limit: { readonly limit: number; readonly windowSec: number },
    who: string,
    window: string,
  ): Promise<void> {
    const result = await this.#kv.increment(key, limit.windowSec);
    if (result.count > limit.limit) {
      throw AuthError.rateLimited(
        result.resetInSec,
        `too many codes requested for ${who} in ${window} — try again later`,
      );
    }
  }

  async #burn(requestId: string): Promise<void> {
    await this.#kv.delete(otpKey(requestId));
    await this.#kv.delete(otpAttemptsKey(requestId));
  }
}

function parseRecord(raw: string): OtpRecord | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'phone' in parsed &&
      'codeHash' in parsed &&
      typeof parsed.phone === 'string' &&
      typeof parsed.codeHash === 'string'
    ) {
      return { phone: parsed.phone, codeHash: parsed.codeHash };
    }
    return null;
  } catch {
    return null;
  }
}
