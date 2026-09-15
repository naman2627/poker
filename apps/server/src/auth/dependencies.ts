import { Redis } from 'ioredis';
import { assertAuthConfig, type AppConfig } from '../config';
import { createDatabase } from '../db/client';
import { createConsoleSmsProvider } from '../sms/console-provider';
import { createSmsProvider } from '../sms/provider';
import {
  createMemoryKeyValueStore,
  createMemoryRefreshTokenRepository,
  createMemoryUserRepository,
} from './memory-adapters';
import { OtpService } from './otp-service';
import { cookiePolicyFor, type CookiePolicy } from './policy';
import { systemClock, type Clock, type UserRepository } from './ports';
import { createRefreshTokenRepository, createUserRepository } from './repositories';
import { createRedisStore } from './redis-store';
import { TokenService } from './token-service';

/**
 * Everything the auth routes need, already built.
 *
 * `buildApp` takes this as an argument rather than constructing it, so a test
 * can hand over in-memory doubles and never open a socket to anything.
 */
export interface AuthDependencies {
  readonly otp: OtpService;
  readonly tokens: TokenService;
  readonly users: UserRepository;
  readonly clock: Clock;
  readonly cookie: CookiePolicy;
  /** Releases the database and Redis connections, if this set owns any. */
  close(): Promise<void>;
}

/** The real thing: Postgres, Redis and the SMS provider named by the config. */
export async function createAuthDependencies(config: AppConfig): Promise<AuthDependencies> {
  const authConfig = assertAuthConfig(config);

  const { db, close: closeDb } = createDatabase(authConfig.DATABASE_URL);
  const redis = new Redis(authConfig.REDIS_URL, { maxRetriesPerRequest: 3 });
  const sms = await createSmsProvider(authConfig);

  const users = createUserRepository(db);
  const refreshTokens = createRefreshTokenRepository(db);
  const clock = systemClock;

  return {
    users,
    clock,
    cookie: cookiePolicyFor(authConfig.NODE_ENV),
    otp: new OtpService({ kv: createRedisStore(redis), users, sms, clock }),
    tokens: new TokenService({
      users,
      refreshTokens,
      clock,
      accessSecret: authConfig.JWT_SECRET,
      refreshSecret: authConfig.JWT_REFRESH_SECRET,
    }),
    close: async (): Promise<void> => {
      redis.disconnect();
      await closeDb();
    },
  };
}

/**
 * The same dependencies, entirely in memory.
 *
 * No Postgres, no Redis, and the one-time code goes to the console. It exists so
 * the whole product can be brought up with `pnpm dev` on a laptop with nothing
 * installed, and so the end-to-end test can sign four browsers in without a
 * container.
 *
 * Everything it holds dies with the process. That is a fine trade for a demo and
 * a disaster for a real table, so production is refused outright rather than
 * left to a misread environment variable.
 */
export function createMemoryAuthDependencies(config: AppConfig): AuthDependencies {
  if (config.NODE_ENV === 'production') {
    throw new Error(
      'AUTH_STORE=memory keeps every account in RAM and loses them on restart. ' +
        'It is refused in production — set DATABASE_URL and REDIS_URL instead.',
    );
  }

  const clock = systemClock;
  const users = createMemoryUserRepository(clock);

  return {
    users,
    clock,
    // Plain http on localhost, so Secure is impossible and Lax is enough.
    cookie: { secure: false, sameSite: 'lax' },
    otp: new OtpService({
      kv: createMemoryKeyValueStore(clock),
      users,
      sms: createConsoleSmsProvider(),
      clock,
    }),
    tokens: new TokenService({
      users,
      refreshTokens: createMemoryRefreshTokenRepository(),
      clock,
      accessSecret: config.JWT_SECRET ?? MEMORY_ACCESS_SECRET,
      refreshSecret: config.JWT_REFRESH_SECRET ?? MEMORY_REFRESH_SECRET,
    }),
    close: () => Promise.resolve(),
  };
}

/**
 * Fixed secrets for a store that cannot outlive the process anyway. They are
 * not a secret in any useful sense and are never reachable in production, which
 * `createMemoryAuthDependencies` refuses outright.
 */
const MEMORY_ACCESS_SECRET = 'in-memory-access-secret-not-for-production-0001';
const MEMORY_REFRESH_SECRET = 'in-memory-refresh-secret-not-for-production-0002';
