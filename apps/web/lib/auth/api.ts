'use client';

import {
  ApiErrorSchema,
  OtpRequestResponseSchema,
  SessionResponseSchema,
  UserResponseSchema,
  type ApiError,
  type OtpRequestResponse,
  type SessionResponse,
  type UserResponse,
} from '@poker/shared';
import { SERVER_URL, currentSearch, isFixtureMode } from '../env';
import { fixtureAuth } from '../../fixtures/auth';

/**
 * The auth endpoints, as the browser sees them.
 *
 * Every response is parsed with the schema `@poker/shared` already defines for
 * it, so a server that changed shape is a caught error here rather than
 * `undefined` three components later. Failures come back as `ApiError` — the
 * same envelope the server uses — because the screens have to show them, and
 * "phone: that is not a phone number" is a far better thing to show than
 * "Request failed".
 */
export class AuthRequestError extends Error {
  readonly body: ApiError;

  constructor(body: ApiError) {
    super(body.message);
    this.name = 'AuthRequestError';
    this.body = body;
  }
}

export async function requestOtp(phone: string): Promise<OtpRequestResponse> {
  if (isFixtureMode(currentSearch())) return fixtureAuth.requestOtp(phone);
  return post('/auth/otp/request', { phone }, OtpRequestResponseSchema);
}

export async function verifyOtp(requestId: string, code: string): Promise<SessionResponse> {
  if (isFixtureMode(currentSearch())) return fixtureAuth.verifyOtp(requestId, code);
  return post('/auth/otp/verify', { requestId, code }, SessionResponseSchema);
}

export async function saveProfile(
  token: string,
  body: { displayName: string; email?: string; avatarSeed: string },
): Promise<UserResponse> {
  if (isFixtureMode(currentSearch())) return fixtureAuth.saveProfile(body);

  // `avatarSeed` is not in ProfileBodySchema yet; the server ignores what it
  // does not know, and the picker keeps working locally either way.
  return post('/auth/profile', body, UserResponseSchema, token);
}

async function post<T>(
  path: string,
  body: unknown,
  schema: { parse(input: unknown): T },
  token?: string,
): Promise<T> {
  let response: Response;

  try {
    response = await fetch(`${SERVER_URL}${path}`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'content-type': 'application/json',
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new AuthRequestError({
      code: 'INTERNAL',
      message: 'could not reach the server — is it running?',
    });
  }

  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const parsed = ApiErrorSchema.safeParse(payload);
    throw new AuthRequestError(
      parsed.success ? parsed.data : { code: 'INTERNAL', message: 'that did not work' },
    );
  }

  const parsed = schema.parse(payload);
  return parsed;
}
