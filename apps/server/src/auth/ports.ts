/**
 * What the auth service needs from the outside world, as interfaces.
 *
 * Production wires Postgres (Drizzle) and Redis behind these. Tests wire
 * in-memory doubles, which is why the whole of auth can be tested without a
 * container: the rules live above these ports, not inside them.
 */

/** Milliseconds since the epoch. Injected so tests can move time. */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

export interface RateLimitResult {
  /** The count after this call. */
  readonly count: number;
  /** Seconds until the window resets. */
  readonly resetInSec: number;
}

/** The slice of Redis the auth service uses. */
export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  delete(key: string): Promise<void>;
  /** Atomic increment; the TTL is applied when the key first appears. */
  increment(key: string, ttlSeconds: number): Promise<RateLimitResult>;
}

export interface UserRecord {
  readonly id: string;
  readonly phone: string;
  readonly phoneVerified: boolean;
  readonly email: string | null;
  readonly emailVerified: boolean;
  readonly displayName: string;
  readonly avatarSeed: string | null;
  readonly createdAt: Date;
  readonly lastSeenAt: Date | null;
}

export interface CreateUserInput {
  readonly phone: string;
  readonly avatarSeed: string;
}

export interface UpdateProfileInput {
  readonly displayName: string;
  readonly email: string | null;
}

export interface UserRepository {
  findById(id: string): Promise<UserRecord | null>;
  findByPhone(phone: string): Promise<UserRecord | null>;
  findByEmail(email: string): Promise<UserRecord | null>;
  /** Creates a phone-verified user with an empty display name. */
  create(input: CreateUserInput): Promise<UserRecord>;
  updateProfile(id: string, input: UpdateProfileInput): Promise<UserRecord>;
  touchLastSeen(id: string, at: Date): Promise<void>;
}

export interface RefreshTokenRecord {
  readonly id: string;
  readonly userId: string;
  readonly tokenHash: string;
  readonly familyId: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
  readonly replacedBy: string | null;
}

export interface CreateRefreshTokenInput {
  readonly userId: string;
  readonly tokenHash: string;
  readonly familyId: string;
  readonly expiresAt: Date;
}

export interface RefreshTokenRepository {
  create(input: CreateRefreshTokenInput): Promise<RefreshTokenRecord>;
  findByHash(tokenHash: string): Promise<RefreshTokenRecord | null>;
  /** Marks the old row revoked and points it at the token that replaced it. */
  markRotated(id: string, replacedBy: string, at: Date): Promise<void>;
  /** Revokes every unrevoked row in the family. Returns how many were killed. */
  revokeFamily(familyId: string, at: Date): Promise<number>;
}
