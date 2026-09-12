import { randomUUID } from 'node:crypto';
import type {
  Clock,
  CreateRefreshTokenInput,
  CreateUserInput,
  KeyValueStore,
  RefreshTokenRecord,
  RefreshTokenRepository,
  UpdateProfileInput,
  UserRecord,
  UserRepository,
} from './ports';

/**
 * The auth ports, backed by a Map.
 *
 * Everything auth actually *decides* — expiry, attempt counting, rate-limit
 * windows, token rotation — is logic above these ports, so a table of Maps is
 * enough to run the whole flow. That is what makes it possible to bring the
 * server up with no Postgres and no Redis, which is how the end-to-end test
 * signs four browsers in without a container.
 *
 * Nothing here persists. A restart is a fresh, empty world, and
 * `createMemoryAuthDependencies` refuses to build one in production for exactly
 * that reason.
 */
export function createMemoryKeyValueStore(clock: Clock): KeyValueStore {
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
      items.set(key, { value, expiresAt: clock.now() + ttlSeconds * 1_000 });
      return Promise.resolve();
    },

    delete: (key) => {
      items.delete(key);
      return Promise.resolve();
    },

    increment: (key, ttlSeconds) => {
      const current = read(key);
      const count = (current === null ? 0 : Number(current)) + 1;
      const existing = items.get(key);
      const expiresAt =
        current === null || !existing ? clock.now() + ttlSeconds * 1_000 : existing.expiresAt;

      items.set(key, { value: String(count), expiresAt });
      return Promise.resolve({
        count,
        resetInSec: Math.max(0, Math.ceil((expiresAt - clock.now()) / 1_000)),
      });
    },
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

export function createMemoryRefreshTokenRepository(): RefreshTokenRepository & {
  all(): RefreshTokenRecord[];
} {
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
