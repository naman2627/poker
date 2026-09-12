'use client';

import {
  ApiErrorSchema,
  LeaderboardResponseSchema,
  PlayerProfileResponseSchema,
  type ApiError,
  type LeaderboardMetric,
  type LeaderboardPeriod,
  type LeaderboardResponse,
  type PlayerProfileResponse,
} from '@poker/shared';
import { SERVER_URL } from '../env';

/**
 * Reading the boards.
 *
 * Every response is parsed with the schema `@poker/shared` defines for it, so a
 * server that has changed shape is a caught error here rather than `undefined`
 * three components later — the same rule the auth and history clients follow.
 */
export class StatsRequestError extends Error {
  readonly body: ApiError;

  constructor(body: ApiError) {
    super(body.message);
    this.name = 'StatsRequestError';
    this.body = body;
  }
}

export function fetchLeaderboard(
  token: string,
  metric: LeaderboardMetric,
  period: LeaderboardPeriod,
): Promise<LeaderboardResponse> {
  const query = new URLSearchParams({ metric, period });
  return get(`/leaderboard?${query.toString()}`, token, LeaderboardResponseSchema);
}

export function fetchPlayer(token: string, userId: string): Promise<PlayerProfileResponse> {
  return get(`/players/${encodeURIComponent(userId)}`, token, PlayerProfileResponseSchema);
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
    throw new StatsRequestError({
      code: 'INTERNAL',
      message: 'could not reach the server — is it running?',
    });
  }

  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const parsed = ApiErrorSchema.safeParse(payload);
    throw new StatsRequestError(
      parsed.success ? parsed.data : { code: 'INTERNAL', message: 'that did not work' },
    );
  }

  return schema.parse(payload);
}
