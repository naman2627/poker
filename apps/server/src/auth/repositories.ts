import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Database } from '../db/client';
import { refreshTokens, users, type RefreshTokenRow, type UserRow } from '../db/schema';
import { AuthError } from './errors';
import type {
  CreateRefreshTokenInput,
  CreateUserInput,
  RefreshTokenRecord,
  RefreshTokenRepository,
  UpdateProfileInput,
  UserRecord,
  UserRepository,
} from './ports';

/** Drizzle behind the repository ports. Nothing else in auth imports the schema. */
export function createUserRepository(db: Database): UserRepository {
  return {
    async findById(id: string): Promise<UserRecord | null> {
      const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1);
      return row ? toUser(row) : null;
    },

    async findByPhone(phone: string): Promise<UserRecord | null> {
      const [row] = await db.select().from(users).where(eq(users.phone, phone)).limit(1);
      return row ? toUser(row) : null;
    },

    async findByEmail(email: string): Promise<UserRecord | null> {
      const [row] = await db.select().from(users).where(eq(users.email, email)).limit(1);
      return row ? toUser(row) : null;
    },

    async create(input: CreateUserInput): Promise<UserRecord> {
      const [row] = await db
        .insert(users)
        .values({
          phone: input.phone,
          phoneVerified: true,
          avatarSeed: input.avatarSeed,
          lastSeenAt: new Date(),
        })
        .returning();
      if (!row) throw new Error('inserting a user returned nothing');
      return toUser(row);
    },

    async updateProfile(id: string, input: UpdateProfileInput): Promise<UserRecord> {
      const [row] = await db
        .update(users)
        .set({
          displayName: input.displayName,
          email: input.email,
          // Setting an address does not prove it; verifying one is its own flow.
          emailVerified: false,
        })
        .where(eq(users.id, id))
        .returning();
      if (!row) throw AuthError.notFound('that account no longer exists');
      return toUser(row);
    },

    async touchLastSeen(id: string, at: Date): Promise<void> {
      await db.update(users).set({ lastSeenAt: at }).where(eq(users.id, id));
    },
  };
}

export function createRefreshTokenRepository(db: Database): RefreshTokenRepository {
  return {
    async create(input: CreateRefreshTokenInput): Promise<RefreshTokenRecord> {
      const [row] = await db
        .insert(refreshTokens)
        .values({
          userId: input.userId,
          tokenHash: input.tokenHash,
          familyId: input.familyId,
          expiresAt: input.expiresAt,
        })
        .returning();
      if (!row) throw new Error('inserting a refresh token returned nothing');
      return toToken(row);
    },

    async findByHash(tokenHash: string): Promise<RefreshTokenRecord | null> {
      const [row] = await db
        .select()
        .from(refreshTokens)
        .where(eq(refreshTokens.tokenHash, tokenHash))
        .limit(1);
      return row ? toToken(row) : null;
    },

    async markRotated(id: string, replacedBy: string, at: Date): Promise<void> {
      await db
        .update(refreshTokens)
        .set({ revokedAt: at, replacedBy })
        .where(eq(refreshTokens.id, id));
    },

    async revokeFamily(familyId: string, at: Date): Promise<number> {
      const revoked = await db
        .update(refreshTokens)
        .set({ revokedAt: at })
        .where(and(eq(refreshTokens.familyId, familyId), isNull(refreshTokens.revokedAt)))
        .returning({ id: refreshTokens.id });
      return revoked.length;
    },
  };
}

/** True when the database is reachable; used by the readiness check. */
export async function pingDatabase(db: Database): Promise<void> {
  await db.execute(sql`select 1`);
}

function toUser(row: UserRow): UserRecord {
  return {
    id: row.id,
    phone: row.phone,
    phoneVerified: row.phoneVerified,
    email: row.email,
    emailVerified: row.emailVerified,
    displayName: row.displayName,
    avatarSeed: row.avatarSeed,
    createdAt: row.createdAt,
    lastSeenAt: row.lastSeenAt,
  };
}

function toToken(row: RefreshTokenRow): RefreshTokenRecord {
  return {
    id: row.id,
    userId: row.userId,
    tokenHash: row.tokenHash,
    familyId: row.familyId,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    replacedBy: row.replacedBy,
  };
}
