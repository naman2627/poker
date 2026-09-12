'use client';

import {
  ApiErrorSchema,
  HandDetailSchema,
  HandHistoryResponseSchema,
  HandVerificationSchema,
  type ApiError,
  type HandDetail,
  type HandHistoryResponse,
  type HandVerification,
} from '@poker/shared';
import { SERVER_URL } from '../env';

/**
 * Reading a table's record back.
 *
 * Every response is parsed with the schema `@poker/shared` defines for it, so a
 * server that changed shape is a caught error here rather than `undefined` three
 * components later — the same rule the auth client follows.
 */
export class HistoryRequestError extends Error {
  readonly body: ApiError;

  constructor(body: ApiError) {
    super(body.message);
    this.name = 'HistoryRequestError';
    this.body = body;
  }
}

export function fetchHandHistory(token: string, code: string): Promise<HandHistoryResponse> {
  return get(`/tables/${encodeURIComponent(code)}/hands`, token, HandHistoryResponseSchema);
}

export function fetchHand(token: string, handId: string): Promise<HandDetail> {
  return get(`/hands/${encodeURIComponent(handId)}`, token, HandDetailSchema);
}

export function fetchVerification(token: string, handId: string): Promise<HandVerification> {
  return get(`/hands/${encodeURIComponent(handId)}/verify`, token, HandVerificationSchema);
}

async function get<T>(
  path: string,
  token: string,
  schema: { parse(input: unknown): T },
): Promise<T> {
  let response: Response;

  try {
    response = await fetch(`${SERVER_URL}${path}`, {
      credentials: 'include',
      headers: { authorization: `Bearer ${token}` },
    });
  } catch {
    throw new HistoryRequestError({
      code: 'INTERNAL',
      message: 'could not reach the server — is it running?',
    });
  }

  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const parsed = ApiErrorSchema.safeParse(payload);
    throw new HistoryRequestError(
      parsed.success ? parsed.data : { code: 'INTERNAL', message: 'that did not work' },
    );
  }

  return schema.parse(payload);
}
