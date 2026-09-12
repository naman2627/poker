import { randomUUID } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { AuthError } from './errors';
import { ACCESS_TOKEN_TTL_SEC, REFRESH_TOKEN_TTL_SEC } from './policy';
import type { Clock, RefreshTokenRepository, UserRecord, UserRepository } from './ports';
import { digestsMatch, generateRefreshToken, hashRefreshToken } from './secrets';

export interface TokenServiceDeps {
  readonly users: UserRepository;
  readonly refreshTokens: RefreshTokenRepository;
  readonly clock: Clock;
  readonly accessSecret: string;
  /** Peppers the refresh-token hash, so the table alone is not enough. */
  readonly refreshSecret: string;
}

export interface IssuedSession {
  readonly accessToken: string;
  readonly expiresInSec: number;
  readonly refreshToken: string;
  readonly refreshExpiresAt: Date;
  readonly user: UserRecord;
}

const ISSUER = 'poker';
const AUDIENCE = 'poker-web';

/**
 * Access tokens and refresh tokens.
 *
 * The access token is a short HS256 JWT the client sends on every request. The
 * refresh token is opaque randomness in an httpOnly cookie, rotated on every
 * use: each rotation revokes the row it replaced and records what replaced it,
 * which is what makes a replayed token detectable. Seeing one is treated as a
 * theft — the whole family is revoked and that login has to start again.
 */
export class TokenService {
  readonly #users: UserRepository;
  readonly #refreshTokens: RefreshTokenRepository;
  readonly #clock: Clock;
  readonly #accessKey: Uint8Array;
  readonly #refreshSecret: string;

  constructor(deps: TokenServiceDeps) {
    this.#users = deps.users;
    this.#refreshTokens = deps.refreshTokens;
    this.#clock = deps.clock;
    this.#accessKey = new TextEncoder().encode(deps.accessSecret);
    this.#refreshSecret = deps.refreshSecret;
  }

  /** A fresh login: a new refresh family, and the first token in it. */
  async startSession(user: UserRecord): Promise<IssuedSession> {
    return this.#issue(user, randomUUID());
  }

  /**
   * Swap a refresh token for the next one in its family.
   *
   * Four things can be wrong with the token presented, and only one of them is
   * interesting: a token that was already rotated away is one somebody kept a
   * copy of, so every token in the family dies with it.
   */
  async rotate(presented: string): Promise<IssuedSession> {
    const tokenHash = hashRefreshToken(presented, this.#refreshSecret);
    const row = await this.#refreshTokens.findByHash(tokenHash);
    const now = new Date(this.#clock.now());

    if (!row || !digestsMatch(row.tokenHash, tokenHash)) {
      throw AuthError.unauthenticated('please sign in again');
    }

    if (row.revokedAt !== null) {
      await this.#refreshTokens.revokeFamily(row.familyId, now);
      throw AuthError.unauthenticated(
        'this session was already used elsewhere — please sign in again',
      );
    }

    if (row.expiresAt.getTime() <= now.getTime()) {
      throw AuthError.unauthenticated('this session has expired — please sign in again');
    }

    const user = await this.#users.findById(row.userId);
    if (!user) throw AuthError.unauthenticated('please sign in again');

    const next = await this.#issue(user, row.familyId);
    await this.#refreshTokens.markRotated(row.id, next.refreshTokenId, now);
    await this.#users.touchLastSeen(user.id, now);
    return next;
  }

  /** Logout: the presented token and every sibling it was rotated from. */
  async revokeSession(presented: string): Promise<void> {
    const row = await this.#refreshTokens.findByHash(
      hashRefreshToken(presented, this.#refreshSecret),
    );
    if (!row) return;
    await this.#refreshTokens.revokeFamily(row.familyId, new Date(this.#clock.now()));
  }

  /** Verifies a bearer token and returns the user it names. */
  async authenticate(accessToken: string): Promise<UserRecord> {
    let subject: string;
    try {
      const { payload } = await jwtVerify(accessToken, this.#accessKey, {
        issuer: ISSUER,
        audience: AUDIENCE,
        algorithms: ['HS256'],
        currentDate: new Date(this.#clock.now()),
      });
      if (typeof payload.sub !== 'string') throw new Error('no subject');
      subject = payload.sub;
    } catch {
      throw AuthError.unauthenticated('your session has expired — please sign in again');
    }

    const user = await this.#users.findById(subject);
    if (!user) throw AuthError.unauthenticated('please sign in again');
    return user;
  }

  async #issue(
    user: UserRecord,
    familyId: string,
  ): Promise<IssuedSession & { refreshTokenId: string }> {
    const now = this.#clock.now();
    const refreshToken = generateRefreshToken();
    const refreshExpiresAt = new Date(now + REFRESH_TOKEN_TTL_SEC * 1000);

    const row = await this.#refreshTokens.create({
      userId: user.id,
      tokenHash: hashRefreshToken(refreshToken, this.#refreshSecret),
      familyId,
      expiresAt: refreshExpiresAt,
    });

    const accessToken = await new SignJWT({ profileComplete: user.displayName !== '' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(user.id)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt(Math.floor(now / 1000))
      .setExpirationTime(Math.floor(now / 1000) + ACCESS_TOKEN_TTL_SEC)
      .sign(this.#accessKey);

    return {
      accessToken,
      expiresInSec: ACCESS_TOKEN_TTL_SEC,
      refreshToken,
      refreshTokenId: row.id,
      refreshExpiresAt,
      user,
    };
  }
}
