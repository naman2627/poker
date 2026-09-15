/**
 * In-memory stand-ins for the auth ports.
 *
 * Everything the auth rules do — expiry, attempt counting, rate limit windows,
 * token rotation — is logic above the port, so these doubles let the whole flow
 * be tested through the real routes without a Postgres or a Redis anywhere.
 * They are deliberately simple: a Map and a clock the test controls.
 */
import { randomUUID } from 'node:crypto';
import type { AuthDependencies } from '../src/auth/dependencies';
import { OtpService } from '../src/auth/otp-service';
import type {
  Clock,
  CreateRefreshTokenInput,
  CreateUserInput,
  KeyValueStore,
  RateLimitResult,
  RefreshTokenRecord,
  RefreshTokenRepository,
  UpdateProfileInput,
  UserRecord,
  UserRepository,
} from '../src/auth/ports';
import { TokenService } from '../src/auth/token-service';
import type { OtpMessage, SmsProvider } from '../src/sms/provider';

export interface TestClock extends Clock {
  advance(ms: number): void;
  set(ms: number): void;
}

export function createTestClock(startMs = Date.UTC(2026, 0, 1, 12, 0, 0)): TestClock {
  let current = startMs;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
    set: (ms: number) => {
      current = ms;
    },
  };
}

export interface MemoryStore extends KeyValueStore {
  /** Every live key, for tests that assert on what was stored. */
  entries(): [string, string][];
}

export function createMemoryStore(clock: Clock): MemoryStore {
  const items = new Map<string, { value: string; expiresAt: number }>();

  const read = (key: string): string | null => {
    const item = items.get(key);
    if (!item) return null;
    if (item.expiresAt <= clock.now()) {
      items.delete(key);
      return null;
    }
    return item.value;
  };

  return {
    get: (key) => Promise.resolve(read(key)),

    set: (key, value, ttlSeconds) => {
      items.set(key, { value, expiresAt: clock.now() + ttlSeconds * 1000 });
      return Promise.resolve();
    },

    delete: (key) => {
      items.delete(key);
      return Promise.resolve();
    },

    increment: (key, ttlSeconds): Promise<RateLimitResult> => {
      const existing = read(key);
      const expiresAt = existing
        ? (items.get(key)?.expiresAt ?? clock.now() + ttlSeconds * 1000)
        : clock.now() + ttlSeconds * 1000;
      const count = Number(existing ?? 0) + 1;
      items.set(key, { value: String(count), expiresAt });
      return Promise.resolve({
        count,
        resetInSec: Math.max(1, Math.ceil((expiresAt - clock.now()) / 1000)),
      });
    },

    entries: () =>
      [...items.entries()]
        .filter(([, item]) => item.expiresAt > clock.now())
        .map(([key, item]) => [key, item.value] as [string, string]),
  };
}

export function createMemoryUserRepository(clock: Clock): UserRepository {
  const rows = new Map<string, UserRecord>();

  return {
    findById: (id) => Promise.resolve(rows.get(id) ?? null),

    findByPhone: (phone) =>
      Promise.resolve([...rows.values()].find((row) => row.phone === phone) ?? null),

    findByEmail: (email) =>
      Promise.resolve([...rows.values()].find((row) => row.email === email) ?? null),

    create: (input: CreateUserInput) => {
      const row: UserRecord = {
        id: randomUUID(),
        phone: input.phone,
        phoneVerified: true,
        email: null,
        emailVerified: false,
        displayName: '',
        avatarSeed: input.avatarSeed,
        createdAt: new Date(clock.now()),
        lastSeenAt: new Date(clock.now()),
      };
      rows.set(row.id, row);
      return Promise.resolve(row);
    },

    updateProfile: (id, input: UpdateProfileInput) => {
      const existing = rows.get(id);
      if (!existing) throw new Error(`no user ${id}`);
      const updated: UserRecord = {
        ...existing,
        displayName: input.displayName,
        email: input.email,
        emailVerified: false,
      };
      rows.set(id, updated);
      return Promise.resolve(updated);
    },

    touchLastSeen: (id, at) => {
      const existing = rows.get(id);
      if (existing) rows.set(id, { ...existing, lastSeenAt: at });
      return Promise.resolve();
    },
  };
}

export interface MemoryRefreshTokenRepository extends RefreshTokenRepository {
  all(): RefreshTokenRecord[];
}

export function createMemoryRefreshTokenRepository(): MemoryRefreshTokenRepository {
  const rows = new Map<string, RefreshTokenRecord>();

  return {
    create: (input: CreateRefreshTokenInput) => {
      const row: RefreshTokenRecord = {
        id: randomUUID(),
        userId: input.userId,
        tokenHash: input.tokenHash,
        familyId: input.familyId,
        createdAt: new Date(),
        expiresAt: input.expiresAt,
        revokedAt: null,
        replacedBy: null,
      };
      rows.set(row.id, row);
      return Promise.resolve(row);
    },

    findByHash: (tokenHash) =>
      Promise.resolve([...rows.values()].find((row) => row.tokenHash === tokenHash) ?? null),

    markRotated: (id, replacedBy, at) => {
      const row = rows.get(id);
      if (row) rows.set(id, { ...row, revokedAt: at, replacedBy });
      return Promise.resolve();
    },

    revokeFamily: (familyId, at) => {
      let revoked = 0;
      for (const [id, row] of rows) {
        if (row.familyId === familyId && row.revokedAt === null) {
          rows.set(id, { ...row, revokedAt: at });
          revoked += 1;
        }
      }
      return Promise.resolve(revoked);
    },

    all: () => [...rows.values()],
  };
}

export interface RecordingSmsProvider extends SmsProvider {
  readonly sent: OtpMessage[];
  last(): OtpMessage;
}

/** Stands in for a real gateway and remembers what it was asked to send. */
export function createRecordingSmsProvider(): RecordingSmsProvider {
  const sent: OtpMessage[] = [];
  return {
    name: 'console',
    sent,
    sendOtp: (message: OtpMessage) => {
      sent.push(message);
      return Promise.resolve();
    },
    last: () => {
      const message = sent[sent.length - 1];
      if (!message) throw new Error('no SMS has been sent');
      return message;
    },
  };
}

export interface TestAuth extends AuthDependencies {
  readonly clock: TestClock;
  readonly kv: MemoryStore;
  readonly sms: RecordingSmsProvider;
  readonly refreshTokens: MemoryRefreshTokenRepository;
}

/** A complete set of auth dependencies, all of it in memory. */
export function createTestAuth(): TestAuth {
  const clock = createTestClock();
  const kv = createMemoryStore(clock);
  const users = createMemoryUserRepository(clock);
  const refreshTokens = createMemoryRefreshTokenRepository();
  const sms = createRecordingSmsProvider();

  return {
    clock,
    kv,
    sms,
    users,
    refreshTokens,
    cookie: { secure: true, sameSite: 'none' as const },
    otp: new OtpService({ kv, users, sms, clock }),
    tokens: new TokenService({
      users,
      refreshTokens,
      clock,
      accessSecret: 'test-access-secret-that-is-long-enough-1234',
      refreshSecret: 'test-refresh-secret-that-is-long-enough-5678',
    }),
    close: () => Promise.resolve(),
  };
}
