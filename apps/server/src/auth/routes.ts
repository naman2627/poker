import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodType, z } from 'zod';
import {
  OtpRequestBodySchema,
  OtpVerifyBodySchema,
  ProfileBodySchema,
  type OtpRequestResponse,
  type PublicUser,
  type SessionResponse,
  type UserResponse,
} from '@poker/shared';
import { AuthError } from './errors';
import type { OtpService } from './otp-service';
import { REFRESH_COOKIE_NAME, REFRESH_COOKIE_PATH, type CookiePolicy } from './policy';
import type { Clock, UserRecord, UserRepository } from './ports';
import type { IssuedSession, TokenService } from './token-service';

export interface AuthRouteDeps {
  readonly otp: OtpService;
  readonly tokens: TokenService;
  readonly users: UserRepository;
  readonly clock: Clock;
  /** Secure + SameSite for the refresh cookie. See `cookiePolicyFor`. */
  readonly cookie: CookiePolicy;
}

/**
 * The auth endpoints.
 *
 * Handlers do three things and nothing else: parse the body with a schema from
 * @poker/shared, call a service, and shape the reply. No SMS provider, no
 * Redis key and no SQL appears in this file.
 */
export function registerAuthRoutes(app: FastifyInstance, deps: AuthRouteDeps): void {
  app.post('/auth/otp/request', async (request): Promise<OtpRequestResponse> => {
    const body = parse(OtpRequestBodySchema, request.body);
    return deps.otp.request(body.phone, request.ip);
  });

  app.post('/auth/otp/verify', async (request, reply): Promise<SessionResponse> => {
    const body = parse(OtpVerifyBodySchema, request.body);
    const { user, isNewUser } = await deps.otp.verify(body.requestId, body.code);
    const session = await deps.tokens.startSession(user);
    setRefreshCookie(reply, session, deps.cookie);

    return {
      accessToken: session.accessToken,
      expiresInSec: session.expiresInSec,
      user: toPublicUser(user),
      isNewUser,
    };
  });

  app.post('/auth/profile', async (request): Promise<UserResponse> => {
    const user = await authenticate(request, deps);
    const body = parse(ProfileBodySchema, request.body);
    const email = body.email ?? null;

    if (email !== null) {
      const owner = await deps.users.findByEmail(email);
      if (owner && owner.id !== user.id) {
        throw AuthError.conflict('that email is already on another account');
      }
    }

    const updated = await deps.users.updateProfile(user.id, {
      displayName: body.displayName,
      email,
    });
    return { user: toPublicUser(updated) };
  });

  app.post('/auth/refresh', async (request, reply): Promise<SessionResponse> => {
    const presented = request.cookies[REFRESH_COOKIE_NAME];
    if (!presented) throw AuthError.unauthenticated('please sign in again');

    let session: IssuedSession;
    try {
      session = await deps.tokens.rotate(presented);
    } catch (error: unknown) {
      // A refused refresh is the end of that cookie's usefulness, whatever the
      // reason, so it does not sit in the browser waiting to fail again.
      clearRefreshCookie(reply, deps.cookie);
      throw error;
    }

    setRefreshCookie(reply, session, deps.cookie);
    return {
      accessToken: session.accessToken,
      expiresInSec: session.expiresInSec,
      user: toPublicUser(session.user),
      isNewUser: false,
    };
  });

  app.post('/auth/logout', async (request, reply): Promise<{ ok: true }> => {
    const presented = request.cookies[REFRESH_COOKIE_NAME];
    if (presented) await deps.tokens.revokeSession(presented);
    clearRefreshCookie(reply, deps.cookie);
    return { ok: true };
  });

  app.get('/auth/me', async (request): Promise<UserResponse> => {
    const user = await authenticate(request, deps);
    return { user: toPublicUser(user) };
  });
}

/** A user as a client may see it: their own row, dates as ISO strings. */
export function toPublicUser(user: UserRecord): PublicUser {
  return {
    id: user.id,
    phone: user.phone,
    phoneVerified: user.phoneVerified,
    email: user.email,
    emailVerified: user.emailVerified,
    displayName: user.displayName,
    avatarSeed: user.avatarSeed,
    profileComplete: user.displayName !== '',
    createdAt: user.createdAt.toISOString(),
    lastSeenAt: user.lastSeenAt === null ? null : user.lastSeenAt.toISOString(),
  };
}

async function authenticate(request: FastifyRequest, deps: AuthRouteDeps): Promise<UserRecord> {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    throw AuthError.unauthenticated('this endpoint needs an access token');
  }
  return deps.tokens.authenticate(header.slice('Bearer '.length).trim());
}

function setRefreshCookie(reply: FastifyReply, session: IssuedSession, cookie: CookiePolicy): void {
  reply.setCookie(REFRESH_COOKIE_NAME, session.refreshToken, {
    httpOnly: true,
    secure: cookie.secure,
    sameSite: cookie.sameSite,
    path: REFRESH_COOKIE_PATH,
    expires: session.refreshExpiresAt,
  });
}

function clearRefreshCookie(reply: FastifyReply, cookie: CookiePolicy): void {
  reply.clearCookie(REFRESH_COOKIE_NAME, {
    httpOnly: true,
    secure: cookie.secure,
    sameSite: cookie.sameSite,
    path: REFRESH_COOKIE_PATH,
  });
}

/** Bad input is a client's mistake, so it comes back as a message, not a 500. */
function parse<S extends ZodType>(schema: S, input: unknown): z.infer<S> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;

  const issue = result.error.issues[0];
  const field = issue?.path.join('.');
  const message = issue?.message ?? 'that request did not make sense';
  throw AuthError.invalidInput(field ? `${field}: ${message}` : message);
}
